import * as THREE from "three";
import { createRenderer } from "./core/renderer.js";
import { createCamera } from "./core/camera.js";
import { createStats } from "./core/stats.js";
import { addLights } from "./world/lights.js";
import { addGround } from "./world/ground.js";
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
// Fog fades far grass + ground into the haze (hides the field edge, adds depth). DECOUPLED from
// the sky: a warm FOG haze glows at the horizon under the blue sky. Far (30) sits INSIDE the grass
// radius (~36) so the grass fully dissolves to the fog color before its edge → grass haze == sky
// horizon == one continuous surface. (Push far out and the half-fogged grass mismatches the sky.)
scene.fog = new THREE.Fog(COLORS.FOG, 10, 30);

// Camera must be in the scene graph so its child hero light is counted.
scene.add(camera);

// --- World ------------------------------------------------------------------
const { sun } = addLights(scene);
addGround(scene);
const sky = addSky(scene, camera); // gradient dome (warm horizon → blue zenith), follows the camera
addHeroLight(camera); // warm fill on the character, follows the view

// --- Entities ---------------------------------------------------------------
const character = new Character(scene, "/models/Wizard.gltf");

// Grass follows the character, so it needs a reference to it.
const grass = addGrass(scene, character);

// --- Systems ----------------------------------------------------------------
const input = createInput();
const cameraFollow = createCameraFollow(camera, character, input);
const controller = createPlayerController(character, input, cameraFollow);
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
