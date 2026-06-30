import * as THREE from "three";

// Builds the WebGLRenderer (canvas owner + draw pipeline).
// Unity: render pipeline + game window in one object.
export function createRenderer() {
  // powerPreference asks for the discrete GPU, not the iGPU. Matters on laptops.
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Clamp pixel ratio to 2: crisp on high-DPI without 3x+ phone resolutions.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Tone mapping ~ Unity URP Tonemapping + Post Exposure. Applied after lighting.
  // toneMappingExposure is the master brightness dial.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3; // warm, luminous morning

  // Shadow maps on (caster/receiver flags live on the light + meshes).
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap; // softer, filtered edges

  document.body.appendChild(renderer.domElement);
  return renderer;
}
