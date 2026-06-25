import * as THREE from "three";

// Builds the WebGLRenderer — the canvas owner + draw pipeline.
// (Unity: the render pipeline + the game window rolled into one object.)
export function createRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Clamp pixel ratio to 2: crisp on high-DPI without rendering 3x+ the pixels.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Tone mapping ≈ Unity URP Tonemapping + Post Exposure. Applied AFTER all lighting,
  // it's the global "camera" response. toneMappingExposure is our master brightness dial.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.4;

  // Shadow maps on (caster/receiver flags live on the light + meshes themselves).
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap; // softer, filtered edges

  document.body.appendChild(renderer.domElement);
  return renderer;
}
