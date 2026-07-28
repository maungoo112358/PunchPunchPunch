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
import placements from "./config/propPlacements.yaml";
import { createInput } from "./systems/input.js";
import { createPlayerController } from "./systems/playerController.js";
import { createWorld, LOCAL_ID } from "./systems/world.js";
import { createWorldView } from "./systems/worldView.js";
import { TICK_DT, MAX_CATCHUP } from "./systems/sim.js";
import { createCameraFollow } from "./systems/cameraFollow.js";
import { createSunFollow } from "./systems/sunFollow.js";
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

// Everyone in the world lives in here, you included, as one entry in a map. The view draws whatever is
// in the map, so a player arriving over the network later is just another entry.
const world = createWorld();
const localPlayer = world.add(LOCAL_ID, spawn);
const view = createWorldView(scene, world, planet);
// Fetch and parse all five character models now, so a joiner wears theirs the instant the server names
// it instead of popping in a moment later.
preloadModels(ALL_MODELS);
// The camera, the grass parting and the sun's shadow all follow you specifically, so they need your
// character object now. Its model is null until the glTF loads, which all three already handle.
const character = view.characterFor(LOCAL_ID);

// Prop placements come from config/propPlacements.yaml. Work out their grass-clearing footprints first,
// from the raw entries, so the grass can carve around each prop as it builds (no blades poking over them).
const propFootprints = footprintsFromEntries(placements, grid);

// Grass over the whole planet; needs the character (parting) + planet (radius/normals).
// path carves its footprint clear of blades; propFootprints clears props.
const grass = addGrass(scene, character, planet, path, propFootprints);

// Load + place every prop from the YAML.
const props = createProps(scene, grid);
props.loadAll(placements);

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
const input = createInput();
const cameraFollow = createCameraFollow(camera, character, input, planet);

// The net layer is built after the login gate resolves, down in startNetworking, not at boot. That lets
// the world render behind the login overlay. Until a token (or a guest's none) comes back, these stay
// null and the render loop simply skips them, and the controller has not yet joined the sim list.
let worldSync: WorldSync | null = null;
let hud: NetHudHandle | null = null;

const sunFollow = createSunFollow(sun, character);

// P puts a second player in the map a few paces away and takes them out again. It only adds and removes
// a map entry, and a whole character appears and vanishes because the view draws the map, which is
// exactly what a snapshot off the network does.
//
// NOT behind import.meta.env.DEV, on purpose and only for now: the deployed build is where models get
// judged, and a DEV-gated key does not exist there at all. Put it back inside the gate once the KayKit
// versus Quaternius question is settled, because a stray debug key on the live game is not something to
// leave lying around.
{
  const TEST_ID = "test";
  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyP") {
      if (world.players.has(TEST_ID)) {
        world.remove(TEST_ID);
        console.log("test player removed");
      } else {
        const at = spawn.clone().add(new THREE.Vector3(4, 0, 2));
        planet.placeOnSurface(at);
        const test = world.add(TEST_ID, at);
        // Wears the KayKit mage so it stands next to your Quaternius character under the same sun, the
        // same toon ramp and the same ink line. That side by side is the whole point of the test player
        // while we are deciding whether to move the cast over to KayKit.
        test.character = "mage";
        test.name = "KayKit Mage";
        console.log("test player added at", at);
      }
    }
  });
}

// --- Update registry ---
// Two lists, because two clocks. Gameplay runs on a fixed tick so the same inputs always produce the
// same result, which is what lets the server run the same walk and lets us replay our own inputs after
// a correction. Everything else is presentation and runs once per drawn frame on real elapsed time.
// Neither list had to declare anything: in TypeScript a thing fits a shape just by having the right
// pieces, unlike C# where each class would have to name an interface to qualify.
type Updatable = { update(dt: number): void };
type Renderable = { render(alpha: number): void };

// Gameplay. Steps by TICK_DT, never by the frame's own time. World goes first: it files everyone's
// current state away as "where they were" before the controller overwrites it. The controller is pushed
// on once networking starts, so before login this list is just world filing away an empty map.
const simulated: Updatable[] = [world];

// Presentation. The draw pass goes first so the models are in place before the camera and the shadow
// follow them.
const drawn: Renderable[] = [view];
const perFrame = [view, cameraFollow, sunFollow, sky, grass].filter(
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

  const controller = createPlayerController(
    localPlayer, input, cameraFollow, planet, path, session.sendInput,
    () => ws.selfCorrection, // the server's latest word on our own player, to reconcile against
  );
  simulated.push(controller); // from now it steps every tick alongside world

  // The netcode HUD. Shipped, not dev-only, because the whole point of prediction and the latency slider
  // only shows against the real round trip of the live server. Toggle the panel with I; O also flips
  // prediction. A once-a-second sampler turns the running byte and correction counters into rates.
  let bytesUpRate = 0, bytesDownRate = 0, corrRate = 0;
  let lastBytesUp = 0, lastBytesDown = 0, lastCorr = 0;
  window.setInterval(() => {
    bytesUpRate = session.bytesUp - lastBytesUp; lastBytesUp = session.bytesUp;
    bytesDownRate = session.bytesDown - lastBytesDown; lastBytesDown = session.bytesDown;
    corrRate = controller.corrections - lastCorr; lastCorr = controller.corrections;
  }, 1000);

  const h = createNetHud({
    rows: () => ({
      rtt: `${timeSync.rttMs.toFixed(0)}ms`,
      tick: ws.serverTick,
      "pred err": controller.predictionError.toFixed(3),
      "corr/s": corrRate,
      "in buf": controller.pending.length,
      "up B/s": bytesUpRate,
      "dn B/s": bytesDownRate,
      id: ws.myId ?? "-",
    }),
    onLatency: (ms) => session.setLatency(ms),
    onTogglePrediction: () => controller.togglePrediction(),
    predictionOn: () => controller.enabled,
    onToggleEncoding: () => session.setEncoding(session.encoding === "json" ? "protobuf" : "json"),
    encoding: () => session.encoding,
  });
  hud = h; // the render loop reads this to draw the readout
  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyI") h.toggle();
    if (e.code === "KeyO") controller.togglePrediction();
  });
}

// --- Resize (wiring layer holds both renderer + camera) ---
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
