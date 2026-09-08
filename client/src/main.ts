import * as THREE from "three";
import { createRenderer } from "./core/renderer.js";
import { createCamera } from "./core/camera.js";
import { addLights } from "./world/lights.js";
import { createPlanet } from "./world/planet.js";
import { createPath } from "./world/path.js";
import { addSky } from "./world/sky.js";
import { addGrass } from "./world/grass.js";
import { addHeroLight } from "./world/heroLight.js";
import { createPlanetGrid } from "./world/planetGrid.js";
import { createProps, footprintsFromEntries } from "./systems/props.js";
import { scatterRandomProps } from "./systems/propScatter.js";
import placements from "./config/propPlacements.yaml";
import { createInput } from "./systems/input.js";
import { createWorld } from "./systems/world.js";
import { createWorldView } from "./systems/worldView.js";
import { createSpellFx } from "./systems/spellFx.js";
import { createTargeting } from "./systems/targeting.js";
import { TICK_DT, MAX_CATCHUP } from "./systems/sim.js";
import { createCameraFollow } from "./systems/cameraFollow.js";
import { createSunFollow } from "./systems/sunFollow.js";
import { createPaperPlane } from "./entities/PaperPlane.js";
import { createGlideFlight } from "./systems/glideFlight.js";
import { createSession } from "./net/session.js";
import { createTimeSync } from "./net/timeSync.js";
import { createWorldSync } from "./systems/worldSync.js";
import type { WorldSync } from "./systems/worldSync.js";
import { preloadModels } from "./entities/Character.js";
import { ALL_MODELS } from "./config/characters.js";
import { createNetHud } from "./systems/netHud.js";
import type { NetHudHandle } from "./systems/netHud.js";
import { showLoginOverlay, restoreLoginToken, restoreGuest, saveGuest } from "./systems/loginOverlay.js";
import { createVoice } from "./systems/voice.js";
import { createVoicePanel, type VoicePanelHandle } from "./systems/voicePanel.js";
import { COLORS } from "./config/palette.js";
import type { PropEditor } from "./systems/propEditor.js";

console.log("PunchPunchPunch booting...");

// --- Core ---
const renderer = createRenderer();
const camera = createCamera();

const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.BACKGROUND); // morning blue sky
// Far fog into haze. Loosened to 60..200 for the planet so the sphere stays visible (the old
// 10..30 range was sized for the flat field). Horizon retune is a later pass.
scene.fog = new THREE.Fog(COLORS.FOG, 60, 200);

// Camera in the scene graph so its child hero light counts.
scene.add(camera);

// --- World ---
const { sun } = addLights(scene);
const planet = createPlanet(scene); // tiny spherical world
const grid = createPlanetGrid(planet.radius); // shared "T10 / T10-2" reference for placing props (pure math)
const path = createPath(scene, planet); // dirt road loop; grass carves to it, speed reads it
const sky = addSky(scene, camera); // flat blue dome + clouds, follows the camera
addHeroLight(camera); // warm fill on the character, follows the view

// --- Entities ---
// Spawn at the north pole, where up == +Y so the character stands upright with no reorientation.
const spawn = new THREE.Vector3(0, planet.radius, 0);

// Everyone ELSE in the world lives in here. The view draws whatever is in the map, so a remote player
// arriving over the network is just another entry. Phase 1 (docs/Phase1.md): the local player is a plane
// now, not a walking character, so it is deliberately not added here — see the flight prototype below.
const world = createWorld();
const spells = createSpellFx(scene); // the beam the wand throws, drawn off the Attack clip
// Input has to exist before targeting, because the cursor IS the crosshair and targeting reads it every
// frame. It used to be built further down with the other systems; it moved up here rather than targeting
// moving down, because targeting has to exist before the view, which asks it what is being aimed at.
const input = createInput();
// Aiming: the mouse cursor is the crosshair, and a ray out through it picks who the wand is pointed at.
const targeting = createTargeting(world, camera, input);
const view = createWorldView(scene, world, planet, spells, () => targeting.targetId);
// Fetch and parse all five character models now, so any OTHER connected player wears theirs the instant
// the server names it. Still needed in Phase 1: other real players on the live server are still walking
// characters, only the local player has become a plane.
preloadModels(ALL_MODELS);

// --- Phase 1 flight prototype (docs/Phase1.md) ---
// Replaces the local walking character with a paper plane flown by glide physics. The camera, the grass
// parting and the sun's shadow all follow it the same way they used to follow the character, because
// createPaperPlane hands back the same { model } shape Character.ts does.
const plane = createPaperPlane(0xf4f1e8); // placeholder off-white paper color, easy to swap later
scene.add(plane.model);
const flight = createGlideFlight(plane, input, planet, spawn);

// Prop placements come from config/propPlacements.yaml, plus a fixed random scatter (systems/propScatter.js)
// so there is something to judge motion against while flight-testing (docs/Phase1.md) — remove the scatter
// once the real "dress the planet with props" pass exists. Work out grass-clearing footprints first, from
// the raw entries, so the grass can carve around each prop as it builds (no blades poking over them).
const allPlacements = [...placements, ...scatterRandomProps(spawn.clone().normalize())];
const propFootprints = footprintsFromEntries(allPlacements, grid);

// Grass over the whole planet; needs the plane (parting) + planet (radius/normals).
// path carves its footprint clear of blades; propFootprints clears props.
const grass = addGrass(scene, plane, planet, path, propFootprints);

// Load + place every prop, hand-placed + scattered alike.
const props = createProps(scene, grid);
props.loadAll(allPlacements);

// Dev-only placement editor (press M). import.meta.env.DEV is true under `npm run dev` and false in a
// production build, so Vite strips this block (and the editor + grid modules) out of the released game.
let editor: PropEditor | null = null;
if (import.meta.env.DEV) {
  Promise.all([
    import("./world/gridGizmo.js"),
    import("./systems/propEditor.js"),
    import("./config/controls.yaml"),
  ]).then(([{ createGridGizmo }, { createPropEditor }, controls]) => {
    const gizmo = createGridGizmo(scene, grid);
    editor = createPropEditor({ scene, camera, planet, grid, props, grass, gizmo, controls: controls.default });
  });
}

// --- Systems ---
const cameraFollow = createCameraFollow(camera, plane, input, planet);

// The net layer is built after the login gate resolves, down in startNetworking, not at boot. That lets
// the world render behind the login overlay. Until a token (or a guest's none) comes back, these stay
// null and the render loop simply skips them.
let worldSync: WorldSync | null = null;
let hud: NetHudHandle | null = null;

const sunFollow = createSunFollow(sun, plane);

// --- Update registry ---
// Two lists, because two clocks. Gameplay runs on a fixed tick so the same inputs always produce the
// same result, which is what lets the server run the same walk and lets us replay our own inputs after
// a correction. Everything else is presentation and runs once per drawn frame on real elapsed time.
// Neither list had to declare anything: in TypeScript a thing fits a shape just by having the right
// pieces, unlike C# where each class would have to name an interface to qualify.
type Updatable = { update(dt: number): void };
type Renderable = { render(alpha: number): void };

// Gameplay. Steps by TICK_DT, never by the frame's own time. World goes first: it files away every
// remote player's current state as "where they were" before the next snapshot overwrites it, which is
// what lets worldView blend a smooth glide between ticks. Phase 1: the local player has no per-tick
// controller here anymore (see glideFlight in perFrame instead), so before anyone else joins this list is
// just world filing away an empty map.
const simulated: Updatable[] = [world];

// Presentation. The draw pass goes first so the models are in place before the camera and the shadow
// follow them.
const drawn: Renderable[] = [view];
// targeting goes before view, so the lock is decided against this frame's camera before the view asks
// who it is; spells goes after, so a beam lit this frame reads the arm position the view just drew.
// flight goes first of all: it drives the plane's own transform, and cameraFollow/sunFollow/grass all
// read it this same frame.
const perFrame = [flight, targeting, view, spells, cameraFollow, sunFollow, sky, grass].filter(
  (u): u is Updatable => Boolean(u),
);

const clock = new THREE.Clock(); // getDelta() ~ Time.deltaTime
let accumulator = 0; // unsimulated time carried between frames
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  // In editor mode the editor drives the camera and freezes the play systems; the sky still ticks so
  // the dome tracks the orbiting view.
  if (editor && editor.isActive()) {
    editor.update(dt);
    sky.update?.(dt);
  } else {
    // Spend whole ticks out of the time we have banked, and keep the remainder for next frame. The
    // ceiling matters: a tab you are not looking at gets no frames, so it comes back owing seconds of
    // simulation, and without the clamp that is hundreds of ticks in one go.
    accumulator = Math.min(accumulator + dt, MAX_CATCHUP);
    while (accumulator >= TICK_DT) {
      for (const u of simulated) u.update(TICK_DT);
      accumulator -= TICK_DT;
    }
    // Leftover time as a fraction of a tick: how far past the last tick the picture should be.
    const alpha = accumulator / TICK_DT;
    worldSync?.update(dt); // advance the playback clock and blend remotes into place before anything draws
    for (const r of drawn) r.render(alpha);
    for (const u of perFrame) u.update?.(dt);
  }
  hud?.update(dt); // the netcode readout; counts frames even while hidden so fps is right when opened
  renderer.render(scene, camera);
});

// --- Login gate, then networking ---
// The render loop above is already running, so the world is on screen. Now decide how to connect. A
// remembered login skips straight in for its 24h. A guest remembered in this tab resumes the same avatar
// after a refresh. Only a genuinely new arrival sees the overlay, and its choice, a login or a fresh
// guest, starts the net layer.
const serverUrl = import.meta.env.VITE_SERVER_URL;
// The login endpoint sits beside the socket on the same host: ws(s):// becomes http(s):// and the /ws
// path becomes /login. Derived so there is one server URL to configure, not two that can drift apart.
const loginUrl = serverUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/ws$/, "/login");

// The three ways a session starts. Login carries a token; guest may carry a resume (same avatar back) or
// nothing (a fresh random one). worldView never sees the difference; this only shapes the socket URL and
// whether the assigned avatar gets saved for the next refresh.
type NetStart =
  | { kind: "login"; token: string }
  | { kind: "guest"; resume?: { character: string; name: string } };

const savedToken = restoreLoginToken();
const savedGuest = restoreGuest();
if (savedToken) {
  startNetworking({ kind: "login", token: savedToken });
} else if (savedGuest) {
  startNetworking({ kind: "guest", resume: savedGuest });
} else {
  showLoginOverlay(loginUrl).then(({ token }) =>
    startNetworking(token ? { kind: "login", token } : { kind: "guest" }),
  );
}

// Everything that talks to the server, built once the login gate settles. This is the whole of what
// login moved later: the scene and loop start at boot, this waits for a name.
function startNetworking(start: NetStart) {
  // timeSync lines our clock up with the server's from the pongs; worldSync buffers snapshots and draws
  // remotes a slice in the past so they glide. Your own avatar moves by local prediction, and the
  // server's copy of you is reconciled against in the controller.
  const timeSync = createTimeSync();
  const ws = createWorldSync(world, planet, spawn);
  worldSync = ws; // the render loop reads this to advance playback and blend remotes

  // What rides the socket URL, and why it is the URL and not a cookie: the page and the server are
  // different sites under split hosting, where browsers block cross-site cookies by default. A login
  // sends its token; a resuming guest asks for its old character and name back; a fresh guest sends
  // nothing and the server draws them at random.
  const params = new URLSearchParams();
  if (start.kind === "login") {
    params.set("token", start.token);
  } else if (start.resume) {
    params.set("char", start.resume.character);
    params.set("name", start.resume.name);
  }
  const query = params.toString();
  const socketUrl = query ? `${serverUrl}?${query}` : serverUrl;

  // A guest remembers whatever avatar the server settles on, so the next refresh in this tab resumes it.
  // Saved on Welcome because that is when the server's choice arrives, and it covers both a fresh draw
  // and a resume that had to fall back to a different character. A login does not save; its token is the
  // memory. The rest of the world layer is untouched, which is why onJoin and the others pass straight
  // through.
  // Voice. It carries no sound through our server: each browser opens a direct connection to each other
  // browser and the audio goes straight between them, so all the server does is pass the handshake along.
  // Both of these are declared before the session because the session routes voice messages into them,
  // and both reach back into the session to send. The arrow functions are what let that circle close:
  // they are written now and only run later, once everything exists.
  let voicePanel: VoicePanelHandle | null = null;
  const voice = createVoice({
    sendSignal: (peer, kind, payload) => session.sendVoice(peer, kind, payload),
    onChange: () => voicePanel?.render(),
    onLevel: () => voicePanel?.renderLevel(),
  });

  const isGuest = start.kind === "guest";
  const session = createSession(socketUrl, {
    onWelcome: (welcome) => {
      if (isGuest && welcome.you) saveGuest(welcome.you.character, welcome.you.name);
      // Our own id decides which side of a two-way handshake backs down when both call at once, so voice
      // needs it before it can connect to anyone.
      if (welcome.you) voice.setSelfId(welcome.you.id);
      for (const player of welcome.players) voice.addPlayer(player.id);
      ws.onWelcome(welcome);
    },
    onJoin: (join) => {
      if (join.player) voice.addPlayer(join.player.id);
      ws.onJoin(join);
    },
    onLeave: (leave) => {
      voice.removePlayer(leave.id);
      ws.onLeave(leave);
    },
    onSnapshot: ws.onSnapshot,
    onPong: timeSync.onPong,
    onVoice: voice.handleSignal,
  });

  voicePanel = createVoicePanel({
    peers: voice.peerStates,
    // The panel shows a name, not a "p3". The world map is already carrying it from the join.
    nameFor: (id) => world.players.get(id)?.name || id,
    joined: () => voice.joined,
    micEnabled: () => voice.micEnabled,
    selfSpeaking: () => voice.selfSpeaking,
    selfLevel: () => voice.selfLevel,
    speakingLevel: () => voice.speakingLevel,
    audioState: () => voice.audioState,
    monitoring: () => voice.monitoring,
    onJoin: () => voice.join(),
    onToggleMic: () => voice.setMicEnabled(!voice.micEnabled),
    onToggleMonitor: () => voice.setMonitoring(!voice.monitoring),
  });

  // A clock probe once a second. The first pong sets the offset that lets remotes be drawn in the past;
  // the rest keep it steady and feed the round-trip readout.
  window.setInterval(() => {
    if (session.status === "open") session.sendPing(performance.now());
  }, 1000);

  // Away detection. A hidden tab stays connected (the ping above keeps it alive), so glancing at another
  // tab keeps you standing in the world for everyone. But stay hidden past AWAY_MS and we close the socket,
  // which the server reads as an ordinary leave; coming back reopens it and rejoins, resuming your saved
  // spot. Two minutes is long enough that a quick look away never drops you, short enough that a truly
  // gone player clears out. A hard exit (closed tab or dead connection) is still caught quickly by the
  // socket close or the server's idle kick; this only adds patience for the tab-switch case.
  const AWAY_MS = 2 * 60 * 1000;
  let awayTimer = 0;
  document.addEventListener("visibilitychange", () => {
    window.clearTimeout(awayTimer);
    if (document.hidden) {
      awayTimer = window.setTimeout(() => session.close(), AWAY_MS);
    } else {
      session.reopen(); // no-op unless the away timer had closed us
    }
  });

  // Phase 1 (docs/Phase1.md): there is no local prediction/reconciliation controller anymore. The plane
  // moves by glideFlight in the perFrame list above, and nothing about it is sent over the network yet
  // (known limitation, see Phase1.md — other players on the live server will not see you fly). The
  // netcode HUD's old prediction readout (pred err / corr/s / in buf) has nothing real to show until
  // flight is networked, so those rows are dropped rather than left showing stale walking-sim numbers.
  // RTT/tick/bytes/id stay, since those are real facts about the live connection.
  let bytesUpRate = 0, bytesDownRate = 0;
  let lastBytesUp = 0, lastBytesDown = 0;
  window.setInterval(() => {
    bytesUpRate = session.bytesUp - lastBytesUp; lastBytesUp = session.bytesUp;
    bytesDownRate = session.bytesDown - lastBytesDown; lastBytesDown = session.bytesDown;
  }, 1000);

  const h = createNetHud({
    rows: () => ({
      rtt: `${timeSync.rttMs.toFixed(0)}ms`,
      tick: ws.serverTick,
      "up B/s": bytesUpRate,
      "dn B/s": bytesDownRate,
      id: ws.myId ?? "-",
    }),
    onLatency: (ms) => session.setLatency(ms),
    onTogglePrediction: () => {}, // no local controller to toggle in Phase 1
    predictionOn: () => false,
    onToggleEncoding: () => session.setEncoding(session.encoding === "json" ? "protobuf" : "json"),
    encoding: () => session.encoding,
  });
  hud = h; // the render loop reads this to draw the readout
  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyI") h.toggle();
  });
}

// --- Resize (wiring layer holds both renderer + camera) ---
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
