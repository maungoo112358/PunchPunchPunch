import * as THREE from "three";
import { createRenderer } from "./core/renderer.js";
import { createCamera } from "./core/camera.js";
import { createStats } from "./core/stats.js";
import { addLights } from "./world/lights.js";
import { createPlanet } from "./world/planet.js";
import { createPath } from "./world/path.js";
import { createPond } from "./world/pond.js";
import { addSky } from "./world/sky.js";
import { addGrass } from "./world/grass.js";
import { addHeroLight } from "./world/heroLight.js";
import { createPlanetGrid } from "./world/planetGrid.js";
import { createProps, footprintsFromEntries } from "./systems/props.js";
import placements from "./config/propPlacements.yaml";
import { Character } from "./entities/Character.js";
import { createInput } from "./systems/input.js";
import { createPlayerController } from "./systems/playerController.js";
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

// Pond parked for now: too small and needs a stable camera + a Genshin-style water pass before it earns
// its place. Flip to true to bring the whole pond back (dent, water, grass carve, depth prepass).
const SHOW_POND = false;

// --- World ---
const { sun } = addLights(scene);
const planet = createPlanet(scene); // tiny spherical world
const grid = createPlanetGrid(planet.radius); // shared "T10 / T10-2" reference for placing props (pure math)
const path = createPath(scene, planet); // dirt road loop; grass carves to it, speed reads it
const pond = SHOW_POND ? createPond(scene, planet) : null; // water disc (fresnel uses the built-in camera uniform)
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
// pond + path carve their footprints clear of blades (null pond = no carve); propFootprints clears props.
const grass = addGrass(scene, character, planet, pond, path, propFootprints);

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
const controller = createPlayerController(character, input, cameraFollow, planet, path);
const sunFollow = createSunFollow(sun, character);
const stats = createStats();

// --- Update registry ---
// Anything that ticks once a frame. Every module here already had an update(dt), so none of them had to
// change or declare anything: in TypeScript a thing fits a shape just by having the right pieces. That is
// unlike C#, where each of these classes would have to name an interface to qualify.
type Updatable = { update(dt: number): void };

// Each update(dt) ticks every frame; this array is the Unity update loop.
// Order: drive the character first, then camera/shadow track its new pos.
// filter drops the pond when it is parked (null). The test is still plain Boolean; the "u is Updatable"
// part is us telling TypeScript what filtering leaves behind, which it cannot work out on its own.
const updatables = [controller, character, cameraFollow, pond, sunFollow, sky, grass, stats].filter(
  (u): u is Updatable => Boolean(u),
);

// Size the pond's depth buffer to the real canvas pixel size (drawing buffer = window size * pixel
// ratio). Kept in sync on resize below.
const drawSize = new THREE.Vector2();
renderer.getDrawingBufferSize(drawSize);
pond?.setSize(drawSize.x, drawSize.y);

const clock = new THREE.Clock(); // getDelta() ~ Time.deltaTime
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  // In editor mode the editor drives the camera and freezes the play systems; sky + stats still tick so
  // the dome tracks the orbiting view and the FPS meter keeps reading.
  if (editor && editor.isActive()) {
    editor.update(dt);
    sky.update?.(dt);
    stats.update?.(); // the FPS panel does not care how long the frame took, so it takes no dt
  } else {
    for (const u of updatables) u.update?.(dt);
  }
  pond?.renderDepth(renderer, scene, camera); // fill the depth buffer before the visible frame
  renderer.render(scene, camera);
});

// --- Resize (wiring layer holds both renderer + camera) ---
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.getDrawingBufferSize(drawSize);
  pond?.setSize(drawSize.x, drawSize.y); // keep the depth buffer matched to the canvas
});
