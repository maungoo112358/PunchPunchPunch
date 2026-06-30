import * as THREE from "three";
import { COLORS, srgb } from "../config/palette.js";

// Gradient sky-dome + procedural drifting CLOUDS: a big inside-out sphere shaded from a pale-blue horizon
// up to a clearer-blue zenith, with soft fbm-noise clouds painted across it. NOTE: on the planet the sky
// has its OWN pale-blue horizon (SKY_HORIZON) — it no longer shares the warm beige grass-haze (FOG). That
// sharing was a flat-world trick (grass dissolved into the horizon); on a sphere the grass meets the sky
// at the planet's silhouette, so the beige band was pointless. Output stays RAW sRGB (display space).
//
// Planet-correct: the gradient + clouds key off the LOCAL up (the character's surface normal, which
// cameraFollow writes into camera.up each frame) instead of world +Y — so blue stays overhead and the
// haze stays at the player's horizon as he walks around the globe.
//
// Unity map: a procedural skybox material, but a literal mesh we shade ourselves. The clouds are fbm
// (fractal noise) sampled over the view direction, drifting via uTime — a static cubemap can't move.

const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position); // object-space view direction; independent of where the dome sits
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uHorizon;   // pale blue (raw sRGB) — the sky's own horizon color
  uniform vec3 uZenith;    // clear blue overhead (raw sRGB)
  uniform float uExponent; // gradient shape: lower = blue reaches further down toward the horizon
  uniform vec3 uUp;        // LOCAL up (surface normal at the character) — gradient/clouds align to this

  uniform float uTime;
  uniform vec3 uCloudColor;   // soft white (raw sRGB)
  uniform float uCloudScale;  // noise frequency — bigger = smaller, more numerous puffs
  uniform float uCloudSpeed;  // drift speed across the sky
  uniform float uCloudLow;    // coverage threshold (raise = fewer clouds, more blue gaps)
  uniform float uCloudHigh;   // softness ceiling (gap between low/high = edge softness)
  uniform float uCloudStrength; // max cloud opacity (<1 lets a hint of blue through → softer)

  varying vec3 vDir;

  // --- compact 3D value-noise fbm (no textures) ---
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f); // smootherstep interpolation
    return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                   mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                   mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
    return v;
  }

  void main() {
    // Re-normalize per-pixel: the dome has few segments, so the linearly-interpolated vDir shrinks
    // mid-triangle and the gradient ripples into faint horizontal seams at each latitude ring.
    // Normalizing here makes the gradient exact regardless of tessellation → no seams.
    vec3 dir = normalize(vDir);

    float up = dot(dir, uUp);         // 1 = straight up (local), 0 = local horizon, <0 = below
    float h = max(up, 0.0);
    vec3 sky = mix(uHorizon, uZenith, pow(h, uExponent));

    // Clouds: fbm over the view direction, drifting with time. Faded out toward the horizon so the
    // clouds only inhabit the upper sky.
    vec3 cp = dir * uCloudScale + vec3(uTime * uCloudSpeed, 0.0, uTime * uCloudSpeed * 0.6);
    float cover = smoothstep(uCloudLow, uCloudHigh, fbm(cp));
    float horizonFade = smoothstep(0.05, 0.4, up); // 0 at/below horizon → 1 well up the sky
    float clouds = cover * horizonFade * uCloudStrength;

    vec3 col = mix(sky, uCloudColor, clouds);

    // DITHER: the sky is a very gradual gradient, so adjacent rows of pixels round to the SAME 8-bit
    // color and the eye sees the step as a horizontal seam (banding). Add sub-step (±0.5/255) screen-space
    // noise so pixels randomly round up/down → the hard step dissolves. Standard sky-banding fix.
    float dither = (hash(vec3(gl_FragCoord.xy, 1.0)) - 0.5) / 255.0;
    col += dither;

    // RAW sRGB output (display space) — the dome writes its literal display colors (no tone-map shift).
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function addSky(scene, camera) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uHorizon: { value: new THREE.Vector3(...srgb(COLORS.SKY_HORIZON)) }, // raw sRGB pale blue (own color; decoupled from grass haze)
      uZenith: { value: new THREE.Vector3(...srgb(COLORS.BACKGROUND)) },   // raw sRGB clear blue overhead
      uExponent: { value: 0.32 }, // low → clear blue fills most of the dome, warm haze is just a horizon strip
      uUp: { value: new THREE.Vector3(0, 1, 0) }, // updated each frame from camera.up (local surface normal)

      uTime: { value: 0 },
      uCloudColor: { value: new THREE.Vector3(...srgb(0xf7f5f0)) }, // bright soft white (pops against clear blue)
      uCloudScale: { value: 1.8 }, // lower = larger, band-like clouds (vs many small puffs)
      uCloudSpeed: { value: 0.024 }, // a bit faster → "clouds flying by" feel
      uCloudLow: { value: 0.5 }, // higher → fewer clouds, more clear-blue gaps between them
      uCloudHigh: { value: 0.74 }, // tighter to Low → more defined cloud edges (less milky)
      uCloudStrength: { value: 0.9 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.BackSide, // we're inside the sphere, so render its inner faces
    depthWrite: false, // never occlude scene geometry
    fog: false, // the sky is the backdrop — it isn't fogged itself
  });

  const geo = new THREE.SphereGeometry(100, 32, 16);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; // it surrounds the camera; never cull it
  mesh.renderOrder = -1; // draw first, behind everything else
  scene.add(mesh);

  return {
    update(dt) {
      mesh.position.copy(camera.position); // keep the dome centered on the viewer
      mat.uniforms.uTime.value += dt || 0; // drift the clouds
      mat.uniforms.uUp.value.copy(camera.up); // align gradient/clouds to the player's local up
    },
  };
}
