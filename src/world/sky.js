import * as THREE from "three";
import { COLORS, srgb } from "../config/palette.js";

// Gradient sky-dome: a big inside-out sphere shaded from a warm horizon up to a blue zenith.
// It pulls the SAME two colors as the fog + background, so the grass dissolves into the warm
// horizon and the horizon melts up into blue — no more hard sky/haze "band" (a flat
// scene.background can't gradient; this is the fix). Follows the camera so the player is always
// centered in the dome and the horizon stays at eye level.
//
// Unity map: like a skybox material with a vertical gradient, but here it's a literal mesh we
// shade ourselves. The gradient is driven by the view direction's Y (straight up = 1, horizon = 0).

const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position); // object-space direction; independent of where the dome sits
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform float uExponent; // higher = warm climbs higher (blue only near zenith); lower = blue reaches down

  varying vec3 vDir;

  void main() {
    float h = max(vDir.y, 0.0);            // 0 at the horizon, 1 straight overhead
    vec3 col = mix(uHorizon, uZenith, pow(h, uExponent));
    // RAW sRGB output — uHorizon/uZenith are already display-space values, so the horizon is EXACTLY
    // uHorizon, which equals the grass's uHazeColor → grass haze and sky read as one coherent surface.
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function addSky(scene, camera) {
  const geo = new THREE.SphereGeometry(100, 32, 16);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uHorizon: { value: new THREE.Vector3(...srgb(COLORS.FOG)) },       // raw sRGB warm haze (matches grass)
      uZenith: { value: new THREE.Vector3(...srgb(COLORS.BACKGROUND)) }, // raw sRGB blue overhead
      uExponent: { value: 0.7 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.BackSide, // we're inside the sphere, so render its inner faces
    depthWrite: false, // never occlude scene geometry
    fog: false, // the sky is the backdrop — it isn't fogged itself
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; // it surrounds the camera; never cull it
  mesh.renderOrder = -1; // draw first, behind everything else
  scene.add(mesh);

  return {
    update() {
      mesh.position.copy(camera.position); // keep the dome centered on the viewer
    },
  };
}
