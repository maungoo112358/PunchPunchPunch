import * as THREE from "three";
import { createRenderer } from "./core/renderer.js";
import { createCamera } from "./core/camera.js";
import { createStats } from "./core/stats.js";
import { addLights } from "./world/lights.js";
import { createPlanet } from "./world/planet.js";
import { createPond } from "./world/pond.js";
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
const pond = createPond(scene, planet); // water disc (fresnel uses the built-in camera uniform)
const sky = addSky(scene, camera); // flat blue dome + clouds, follows the camera
addHeroLight(camera); // warm fill on the character, follows the view

// --- Entities ---
// Spawn at the north pole, where up == +Y so the character stands upright with no reorientation.
const spawn = new THREE.Vector3(0, planet.radius, 0);
const character = new Character(scene, "/models/Wizard.gltf", spawn);

// Grass over the whole planet; needs the character (parting) + planet (radius/normals).
// pond is passed so the scatter carves the water footprint clear of blades.
const grass = addGrass(scene, character, planet, pond);

// --- Systems ---
const input = createInput();
const cameraFollow = createCameraFollow(camera, character, input, planet);
const controller = createPlayerController(character, input, cameraFollow, planet);
const sunFollow = createSunFollow(sun, character);
const stats = createStats();

// --- Update registry ---
// Each update(dt) ticks every frame; this array is the Unity update loop.
// Order: drive the character first, then camera/shadow track its new pos.
const updatables = [controller, character, cameraFollow, pond, sunFollow, sky, grass, stats];

const clock = new THREE.Clock(); // getDelta() ~ Time.deltaTime
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  for (const u of updatables) u.update?.(dt);
  renderer.render(scene, camera);
});

// --- Resize (wiring layer holds both renderer + camera) ---
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
