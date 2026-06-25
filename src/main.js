import * as THREE from "three";
import { createRenderer } from "./core/renderer.js";
import { createCamera } from "./core/camera.js";
import { addLights } from "./world/lights.js";
import { addGround } from "./world/ground.js";
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
scene.background = new THREE.Color(COLORS.BACKGROUND); // dim slate-blue

// --- World ------------------------------------------------------------------
const { sun } = addLights(scene);
addGround(scene);

// --- Entities ---------------------------------------------------------------
const character = new Character(scene, "/models/Goblin_Male.gltf");

// --- Systems ----------------------------------------------------------------
const input = createInput();
const controller = createPlayerController(character, input);
const cameraFollow = createCameraFollow(camera, character);
const sunFollow = createSunFollow(sun, character);

// --- Update registry --------------------------------------------------------
// Each entry's update(dt) is ticked every frame — this array IS the Unity update
// loop. Order: drive the character first, then the camera/shadow track its new pos.
const updatables = [controller, character, cameraFollow, sunFollow];

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
