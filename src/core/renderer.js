import * as THREE from "three";

// Builds the WebGLRenderer — the canvas owner + draw pipeline.
// (Unity: the render pipeline + the game window rolled into one object.)
export function createRenderer() {
  // powerPreference hints the OS/browser to use the discrete GPU (not the iGPU) —
  // critical on laptops, where the browser defaults to integrated graphics.
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Clamp pixel ratio to 2: crisp on high-DPI without rendering absurd 3x+ phone
  // resolutions. (A future quality tier can lower this for weak devices.)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Tone mapping ≈ Unity URP Tonemapping + Post Exposure. Applied AFTER all lighting,
  // it's the global "camera" response. toneMappingExposure is our master brightness dial.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15; // dim for the deep twilight mood

  // Shadow maps on (caster/receiver flags live on the light + meshes themselves).
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap; // softer, filtered edges

  document.body.appendChild(renderer.domElement);
  return renderer;
}
