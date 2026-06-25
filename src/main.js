import * as THREE from "three";
import { createRenderer } from "./core/renderer.js";
import { createCamera } from "./core/camera.js";
import { createStats } from "./core/stats.js";
import { addLights } from "./world/lights.js";
import { addGround } from "./world/ground.js";
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
scene.background = new THREE.Color(COLORS.BACKGROUND); // pale hazy sky
// Fog fades far grass + ground into the sky, hiding the field edge (and adding depth).
scene.fog = new THREE.Fog(COLORS.BACKGROUND, 20, 46);

// Camera must be in the scene graph so its child hero light is counted.
scene.add(camera);

// --- World ------------------------------------------------------------------
const { sun } = addLights(scene);
addGround(scene);
addHeroLight(camera); // warm fill on the character, follows the view

// --- Entities ---------------------------------------------------------------
const character = new Character(scene, "/models/Goblin_Male.gltf");

// Grass follows the character, so it needs a reference to it.
const grass = addGrass(scene, character);

// --- Systems ----------------------------------------------------------------
const input = createInput();
const cameraFollow = createCameraFollow(camera, character);
const controller = createPlayerController(character, input, cameraFollow);
const sunFollow = createSunFollow(sun, character);
const stats = createStats();

// --- Update registry --------------------------------------------------------
// Each entry's update(dt) is ticked every frame — this array IS the Unity update
// loop. Order: drive the character first, then the camera/shadow track its new pos.
const updatables = [controller, character, cameraFollow, sunFollow, grass, stats];

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
