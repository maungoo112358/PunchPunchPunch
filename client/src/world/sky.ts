import * as THREE from "three";
import { COLORS, srgb } from "../config/palette.js";
// The shaders live in their own files now. "?raw" is a Vite thing: it hands you the file's text as a
// plain string instead of trying to run it, which is exactly what a ShaderMaterial wants.
import vertexShader from "../shaders/sky.vert?raw";
import fragmentShader from "../shaders/sky.frag?raw";

// Sky dome + drifting clouds: an inside-out sphere with fbm-noise clouds. It can gradient from
// uHorizon to uZenith, but they're set equal right now (flat blue) because any two-color gradient
// showed a Mach band. The sky uses its OWN colors (SKY_HORIZON/BACKGROUND), not the grass haze (FOG):
// on a sphere the grass meets the sky at the silhouette, so a shared band was pointless. Raw sRGB out.
//
// The gradient and clouds key off LOCAL up (the surface normal that cameraFollow writes into camera.up
// each frame) instead of world +Y, so blue stays overhead as the player walks around the globe.
//
// Unity equivalent: a procedural skybox, but a literal mesh we shade ourselves. Clouds are fbm sampled
// over the view direction, drifting via uTime (a static cubemap can't move).
//
// This file is now only about the dome: build it, feed it, keep it on the camera. How a pixel of sky
// actually gets its color is in shaders/sky.frag.

export function addSky(scene: THREE.Scene, camera: THREE.Camera) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uHorizon: { value: new THREE.Vector3(...srgb(COLORS.SKY_HORIZON)) }, // raw sRGB pale blue (decoupled from grass haze)
      uZenith: { value: new THREE.Vector3(...srgb(COLORS.BACKGROUND)) },   // raw sRGB clear blue overhead
      uExponent: { value: 0.32 }, // gradient shape; only matters if uHorizon != uZenith (flat now)
      uUp: { value: new THREE.Vector3(0, 1, 0) }, // updated each frame from camera.up (local surface normal)

      uTime: { value: 0 },
      uCloudColor: { value: new THREE.Vector3(...srgb(0xf7f5f0)) }, // bright soft white
      uCloudScale: { value: 1.8 }, // lower = larger, band-like clouds
      uCloudSpeed: { value: 0.024 }, // drift speed
      uCloudLow: { value: 0.5 }, // higher = fewer clouds, more blue gaps
      uCloudHigh: { value: 0.74 }, // tighter to Low = more defined cloud edges
      uCloudStrength: { value: 0.9 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.BackSide, // we're inside the sphere, so render its inner faces
    depthWrite: false, // never occlude scene geometry
    fog: false, // the sky is the backdrop, not fogged itself
  });

  const geo = new THREE.SphereGeometry(100, 32, 16);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; // it surrounds the camera; never cull it
  mesh.renderOrder = -1; // draw first, behind everything else
  scene.add(mesh);

  return {
    update(dt: number) {
      mesh.position.copy(camera.position); // keep the dome centered on the viewer
      mat.uniforms.uTime.value += dt || 0; // drift the clouds
      mat.uniforms.uUp.value.copy(camera.up); // align gradient/clouds to the player's local up
    },
  };
}
