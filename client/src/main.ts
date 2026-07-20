import * as THREE from "three";
import { createRenderer } from "./core/renderer.js";
import { createCamera } from "./core/camera.js";
import { createStats } from "./core/stats.js";
import { addLights } from "./world/lights.js";
import { createPlanet } from "./world/planet.js";
import { createPath } from "./world/path.js";
import { addSky } from "./world/sky.js";
import { addGrass } from "./world/grass.js";
import { addHeroLight } from "./world/heroLight.js";
import { createPlanetGrid } from "./world/planetGrid.js";
import { createProps, footprintsFromEntries } from "./systems/props.js";
import placements from "./config/propPlacements.yaml";
import { Character } from "./entities/Character.js";
import { createInput } from "./systems/input.js";
import { createPlayerController } from "./systems/playerController.js";
import { TICK_DT, MAX_CATCHUP } from "./systems/sim.js";
import { createCameraFollow } from "./systems/cameraFollow.js";
import { createSunFollow } from "./systems/sunFollow.js";
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
const character = new Character(scene, "/models/Wizard.gltf", spawn);

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
const controller = createPlayerController(character, input, cameraFollow, planet, path, spawn);
const sunFollow = createSunFollow(sun, character);
const stats = createStats();

// --- Update registry ---
// Two lists, because two clocks. Gameplay runs on a fixed tick so the same inputs always produce the
// same result, which is what lets the server run the same walk and lets us replay our own inputs after
// a correction. Everything else is presentation and runs once per drawn frame on real elapsed time.
// Neither list had to declare anything: in TypeScript a thing fits a shape just by having the right
// pieces, unlike C# where each class would have to name an interface to qualify.
type Updatable = { update(dt: number): void };
type Renderable = { render(alpha: number): void };

// Gameplay. Steps by TICK_DT, never by the frame's own time.
const simulated: Updatable[] = [controller];

// Presentation. The draw pass (controller.render) goes first so the model is in place before the camera
// and the shadow follow it.
const drawn: Renderable[] = [controller];
const perFrame = [character, cameraFollow, sunFollow, sky, grass, stats].filter(
  (u): u is Updatable => Boolean(u),
);

const clock = new THREE.Clock(); // getDelta() ~ Time.deltaTime
let accumulator = 0; // unsimulated time carried between frames
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  // In editor mode the editor drives the camera and freezes the play systems; sky + stats still tick so
  // the dome tracks the orbiting view and the FPS meter keeps reading.
  if (editor && editor.isActive()) {
    editor.update(dt);
    sky.update?.(dt);
    stats.update?.(); // the FPS panel does not care how long the frame took, so it takes no dt
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
    for (const r of drawn) r.render(alpha);
    for (const u of perFrame) u.update?.(dt);
  }
  renderer.render(scene, camera);
});

// --- Resize (wiring layer holds both renderer + camera) ---
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
