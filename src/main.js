import * as THREE from "three";
import { createRenderer } from "./core/renderer.js";
import { createCamera } from "./core/camera.js";
import { createStats } from "./core/stats.js";
import { addLights } from "./world/lights.js";
import { createPlanet } from "./world/planet.js";
import { addSky } from "./world/sky.js";
import { addGrass } from "./world/grass.js";
import { addHeroLight } from "./world/heroLight.js";
import { Character } from "./entities/Character.js";
import { createInput } from "./systems/input.js";
import { createPlayerController } from "./systems/playerController.js";
import { createCameraFollow } from "./systems/cameraFollow.js";
import { createSunFollow } from "./systems/sunFollow.js";
import { COLORS } from "./config/palette.js";

console.log("PunchPunchPunch booting...");

// --- Core -------------------------------------------------------------------
const renderer = createRenderer();
const camera = createCamera();

const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.BACKGROUND); // soft morning blue sky
// Fog fades far geometry into the haze. TEMPORARILY LOOSENED for the tiny-planet build (Task 1):
// the old 10→30 range sat inside the flat grass field, but a radius-12 sphere lives entirely inside
// it and would vanish. Pushed far out so the planet's curve is fully visible. The fog↔sky↔horizon
// retune is its own later pass — on a sphere the horizon is the planet's CURVE, not a fogged edge.
scene.fog = new THREE.Fog(COLORS.FOG, 60, 200);

// Camera must be in the scene graph so its child hero light is counted.
scene.add(camera);

// --- World ------------------------------------------------------------------
const { sun } = addLights(scene);
const planet = createPlanet(scene); // tiny spherical world (replaces the flat ground)
const sky = addSky(scene, camera); // gradient dome (warm horizon → blue zenith), follows the camera
addHeroLight(camera); // warm fill on the character, follows the view

// --- Entities ---------------------------------------------------------------
// Spawn at the north pole. There up already == +Y, so the character stands upright with zero
// reorientation. He's parked here until Task 2 ports movement/camera to the curved surface.
const spawn = new THREE.Vector3(0, planet.radius, 0);
const character = new Character(scene, "/models/Wizard.gltf", spawn);

// Grass scattered over the whole planet; needs the character (parting) + planet (radius/normals).
const grass = addGrass(scene, character, planet);

// --- Systems ----------------------------------------------------------------
const input = createInput();
const cameraFollow = createCameraFollow(camera, character, input, planet);
const controller = createPlayerController(character, input, cameraFollow, planet);
const sunFollow = createSunFollow(sun, character);
const stats = createStats();

// --- Update registry --------------------------------------------------------
// Each entry's update(dt) is ticked every frame — this array IS the Unity update
// loop. Order: drive the character first, then the camera/shadow track its new pos.
const updatables = [controller, character, cameraFollow, sunFollow, sky, grass, stats];

const clock = new THREE.Clock(); // clock.getDelta() ≈ Time.deltaTime
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  for (const u of updatables) u.update?.(dt);
  renderer.render(scene, camera);
});

// --- Resize (the wiring layer is the one place that holds both renderer + camera) ---
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
