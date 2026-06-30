import * as THREE from "three";
import { COLORS, srgb } from "../config/palette.js";

// ---------------------------------------------------------------------------
// WHOLE-SPHERE GPU grass (planet version). The old flat field streamed square
// XZ chunks around the player; a tiny planet is FINITE, so instead we scatter
// every blade over the whole sphere ONCE (no streaming, no recycling) and let
// the opaque planet depth-occlude the back hemisphere for free.
//
// The core change from flat: every blade has its OWN up — its surface normal —
// so the blade is built in a per-blade tangent frame (T, B, N) derived in the
// vertex shader from the blade's base position. Wind + player-parting are redone
// in that surface-local frame. The color/haze fragment pipeline is UNCHANGED
// (the locked cozy-morning look). (Patch-level frustum culling = a later pass.)
// ---------------------------------------------------------------------------

const BLADE_COUNT = 250000; // total blades over the whole sphere (front ~half visible); tune by eye + FPS
const BLADE_JITTER = 0.13; // random tangent offset so the Fibonacci spiral doesn't read as a lattice

// Tiny seeded RNG so the layout is deterministic (stable across reloads).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One blade, height baked to 1.0 (so local y == height fraction), 3 segments.
// x = width (±), y = height (0..1). Built into the surface frame in the shader.
const BLADE_POSITIONS = new Float32Array([
  -0.05, 0.0, 0.0, 0.05, 0.0, 0.0, -0.04, 0.33, 0.0, 0.04, 0.33, 0.0, -0.025,
  0.66, 0.0, 0.025, 0.66, 0.0, 0.0, 1.0, 0.0,
]);
const BLADE_INDICES = [0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5, 4, 5, 6];

// Scatter blade bases over the sphere with a Fibonacci (golden-spiral) distribution:
// deterministic and near-uniform with no pole pinch (lat/long would clump at the poles).
function buildGrassGeometry(radius) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(BLADE_POSITIONS, 3));
  geo.setIndex(BLADE_INDICES);

  const aBase = new Float32Array(BLADE_COUNT * 3);
  const aRotation = new Float32Array(BLADE_COUNT);
  const aHeight = new Float32Array(BLADE_COUNT);
  const aPhase = new Float32Array(BLADE_COUNT);

  const rng = mulberry32(0xc0ffee);
  const golden = Math.PI * (3 - Math.sqrt(5)); // ~2.3999 rad between consecutive points
  const dir = new THREE.Vector3();
  const t1 = new THREE.Vector3();
  const t2 = new THREE.Vector3();
  const ref = new THREE.Vector3();
  const base = new THREE.Vector3();

  for (let i = 0; i < BLADE_COUNT; i++) {
    const y = 1 - ((i + 0.5) / BLADE_COUNT) * 2; // +1 (top) → -1 (bottom)
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    dir.set(Math.cos(theta) * r, y, Math.sin(theta) * r); // unit direction on the sphere

    // Jitter within the local tangent plane so the spiral lattice disappears, then re-seat at radius.
    ref.set(0, 1, 0);
    if (Math.abs(dir.y) > 0.99) ref.set(1, 0, 0); // avoid a degenerate cross near the poles
    t1.crossVectors(ref, dir).normalize();
    t2.crossVectors(dir, t1); // already unit (dir ⊥ t1)
    base
      .copy(dir)
      .multiplyScalar(radius)
      .addScaledVector(t1, (rng() * 2 - 1) * BLADE_JITTER)
      .addScaledVector(t2, (rng() * 2 - 1) * BLADE_JITTER)
      .setLength(radius); // snap back onto the surface

    aBase[i * 3 + 0] = base.x;
    aBase[i * 3 + 1] = base.y;
    aBase[i * 3 + 2] = base.z;
    aRotation[i] = rng() * Math.PI * 2;
    aHeight[i] = 0.9 + rng() * 0.6; // ~0.9..1.5 tall
    aPhase[i] = rng() * Math.PI * 2;
  }

  geo.setAttribute("aBase", new THREE.InstancedBufferAttribute(aBase, 3));
  geo.setAttribute("aRotation", new THREE.InstancedBufferAttribute(aRotation, 1));
  geo.setAttribute("aHeight", new THREE.InstancedBufferAttribute(aHeight, 1));
  geo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(aPhase, 1));

  // The whole field is one static mesh covering the planet; bound it to the planet + tallest blade.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius + 2);
  return geo;
}

const vertexShader = /* glsl */ `
  attribute vec3 aBase;     // WORLD position of this blade's base (on the sphere surface)
  attribute float aRotation;
  attribute float aHeight;
  attribute float aPhase;

  varying float vHeight;
  varying vec3 vNormal;

  uniform float uTime;
  uniform vec3 uWindDir;        // world-space wind; projected into each blade's tangent plane
  uniform float uWindFrequency;
  uniform float uWindAmplitude;
  uniform float uWindScale;
  uniform float uGustFrequency;
  uniform float uGustScale;

  uniform vec3 uPlayerPos;      // character world position
  uniform float uPlayerRadius;  // how far the parting reaches
  uniform float uPlayerStrength;// how far blades bend away

  #include <fog_pars_vertex>

  void main() {
    vHeight = position.y; // base geom height is 1.0, so y IS the height fraction

    // PER-BLADE SURFACE FRAME (T, B, N) derived from the base — this is the whole sphere port.
    vec3 N = normalize(aBase); // this blade's up = surface normal
    vec3 ref = abs(N.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0); // flips near the poles
    vec3 T = normalize(cross(ref, N));
    vec3 B = cross(N, T);

    // Spin the blade in its tangent plane: widthAxis widens it, faceAxis is the card's facing.
    float s = sin(aRotation);
    float c = cos(aRotation);
    vec3 widthAxis = T * c + B * s;
    vec3 faceAxis = -T * s + B * c;

    // Build the blade: width along widthAxis, height along the surface normal.
    vec3 worldPos = aBase + widthAxis * position.x + N * (position.y * aHeight);

    // Stylized lighting normal: card normal biased toward the surface up (soft, up-lit look).
    vNormal = normalize(faceAxis * 0.8 + N * 0.6);

    // WIND: project the world wind into this blade's tangent plane, bend the tip along it.
    // Two sine octaves + a slow gust envelope, scaled by vHeight so the root stays planted.
    vec3 windT = uWindDir - N * dot(uWindDir, N);
    windT = normalize(windT + 1e-4 * T); // guard if wind ~parallel to N
    float spatial = aBase.x + aBase.y + aBase.z; // smoothly varies over the sphere (no tiling)
    float t = uTime * uWindFrequency;
    float wave1 = sin(t + spatial * uWindScale + aPhase);
    float wave2 = sin(t * 1.7 + dot(aBase, vec3(0.7, -1.3, 0.5)) * uWindScale * 2.0 + aPhase * 1.3);
    float wave = wave1 * 0.7 + wave2 * 0.3;
    float gust = 0.6 + 0.4 * sin(uTime * uGustFrequency + spatial * uGustScale);
    float bend = wave * gust * uWindAmplitude * vHeight;
    worldPos += windT * bend;

    // PLAYER PARTING: blades within radius bend AWAY along the tangent, tips part, slight press-down.
    vec3 toBlade = aBase - uPlayerPos;
    float pdist = length(toBlade);
    float influence = 1.0 - smoothstep(0.0, uPlayerRadius, pdist); // 1 near → 0 at radius
    vec3 pushDir = toBlade - N * dot(toBlade, N); // flatten into the tangent plane
    float pl = length(pushDir);
    pushDir = pl > 0.001 ? pushDir / pl : vec3(0.0);
    float push = influence * uPlayerStrength * vHeight;
    worldPos += pushDir * push;
    worldPos -= N * (push * 0.35); // trample/flatten near his feet

    vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    #include <fog_vertex>
  }
`;

// Fragment shader — UNCHANGED from the flat field (the locked cozy-morning look).
const fragmentShader = /* glsl */ `
  uniform vec3 uBaseColor;
  uniform vec3 uTipColor;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform float uAmbientStrength;
  uniform float uSunStrength;
  uniform float uTipGlow;
  uniform vec3 uHazeColor; // raw sRGB haze (display space) — shared with the sky horizon

  varying float vHeight;
  varying vec3 vNormal;

  #include <fog_pars_fragment>

  void main() {
    vec3 albedo = mix(uBaseColor, uTipColor, vHeight);

    vec3 N = normalize(vNormal);
    float ndl = abs(dot(N, uSunDir)); // two-sided
    float sun = ndl * 0.5 + 0.5; // half-Lambert wrap

    vec3 ambient = uSkyColor * uAmbientStrength;
    vec3 color = albedo * (ambient + uSunColor * sun * uSunStrength);
    color += albedo * pow(vHeight, 4.0) * uTipGlow; // fake tip translucency

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    // Haze blended LAST, in display space, toward a raw sRGB color — far grass ends at the EXACT
    // same on-screen color as the sky horizon (uHazeColor == sky uHorizon). No tone-map shift.
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, uHazeColor, fogFactor);
  }
`;

export function addGrass(scene, target, planet) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uBaseColor: { value: new THREE.Color(COLORS.GRASS_BASE) },
      uTipColor: { value: new THREE.Color(COLORS.GRASS_TIP) },
      uTime: { value: 0 },
      uWindDir: { value: new THREE.Vector3(1, 0, 0.3).normalize() }, // world wind; projected per blade
      uWindFrequency: { value: 1.2 },
      uWindAmplitude: { value: 0.2 },
      uWindScale: { value: 0.3 },
      uGustFrequency: { value: 0.3 },
      uGustScale: { value: 0.05 },
      uPlayerPos: { value: new THREE.Vector3(1e9, 0, 1e9) }, // off in the void until the model loads
      uPlayerRadius: { value: 1.8 }, // parting radius around the character
      uPlayerStrength: { value: 0.4 }, // how far tips bend away (subtle part, not a blast)
      uSunDir: { value: new THREE.Vector3(5, 5, 4).normalize() }, // mid-morning angle (match lights.js + sunFollow)
      uSunColor: { value: new THREE.Color(COLORS.SUN) },
      uSkyColor: { value: new THREE.Color(COLORS.SKY) },
      uAmbientStrength: { value: 0.5 },
      uSunStrength: { value: 0.8 },
      uTipGlow: { value: 0.22 },
      uHazeColor: { value: new THREE.Vector3(...srgb(COLORS.FOG)) }, // raw sRGB haze — matches sky horizon
      // Fog uniforms — fogNear/fogFar auto-update from scene.fog because fog:true (we do our own blend).
      fogColor: { value: new THREE.Color() },
      fogNear: { value: 1 },
      fogFar: { value: 1000 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    fog: true,
  });

  const geo = buildGrassGeometry(planet.radius);
  const mesh = new THREE.Mesh(geo, material);
  scene.add(mesh);

  return {
    update(dt) {
      material.uniforms.uTime.value += dt;
      if (target && target.model) {
        material.uniforms.uPlayerPos.value.copy(target.model.position); // grass parts around him
      }
    },
  };
}
