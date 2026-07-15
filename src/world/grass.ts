import * as THREE from "three";
import { COLORS, srgb } from "../config/palette.js";
import type { Planet } from "./planet.js";

// Whole-sphere GPU grass. The planet is finite, so scatter every blade over the
// whole sphere once (no streaming) and let the opaque planet occlude the back.
// Each blade has its own up (surface normal), so it's built in a per-blade tangent
// frame (T, B, N) in the vertex shader. Wind and player-parting work in that
// surface-local frame. The color/haze fragment pipeline is unchanged.

const BLADE_COUNT = 400000; // total blades (front ~half visible); tune by eye + FPS
const BLADE_JITTER = 0.13; // random tangent offset so the Fibonacci spiral doesn't read as a lattice
const CARVE_MARGIN = 0.0; // base carve line: grass can reach the exact water edge (fringe adds the poke)
const SHORE_FRINGE = 0.7; // ragged shore: how far blades randomly poke IN over the water, per blade

// The pond and the dirt road both answer the same question: is this spot inside me? Grass only ever
// asks that, so one shape describes both. world/pond.js is still plain JS and it slots in here anyway,
// because in TypeScript matching the shape is all it takes.
type Carve = { contains(worldPos: THREE.Vector3, margin?: number): boolean };

// A circle of cleared ground under a prop, the way the caller hands it to us.
type PropFootprint = { center: THREE.Vector3; radius: number };

// The same circle with the radius already squared, so the blade loop can compare squared distances and
// skip a square root on every one of the 400,000 blades.
type PreppedFootprint = { center: THREE.Vector3; r2: number };

// The character, so the grass can part around him. Null until the glTF finishes loading.
type GrassTarget = { model: THREE.Object3D | null };

// Seeded RNG so the layout is deterministic across reloads.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One blade, height baked to 1.0 (local y == height fraction), 3 segments.
// x = width, y = height (0..1). Built into the surface frame in the shader.
const BLADE_POSITIONS = new Float32Array([
  -0.05, 0.0, 0.0, 0.05, 0.0, 0.0, -0.04, 0.33, 0.0, 0.04, 0.33, 0.0, -0.025,
  0.66, 0.0, 0.025, 0.66, 0.0, 0.0, 1.0, 0.0,
]);
const BLADE_INDICES = [0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5, 4, 5, 6];

// Scatter blade bases with a Fibonacci (golden-spiral) distribution:
// deterministic, near-uniform, no pole pinch (lat/long would clump at the poles).
function buildGrassGeometry(
  radius: number,
  pond: Carve | null,
  path: Carve | null,
  propFootprints: PreppedFootprint[],
) {
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

  let k = 0; // write index for kept blades (carved ones are skipped, but still draw rng)
  for (let i = 0; i < BLADE_COUNT; i++) {
    const y = 1 - ((i + 0.5) / BLADE_COUNT) * 2; // +1 (top) to -1 (bottom)
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    dir.set(Math.cos(theta) * r, y, Math.sin(theta) * r); // unit direction on the sphere

    // Jitter in the tangent plane to break the spiral lattice, then re-seat at radius.
    ref.set(0, 1, 0);
    if (Math.abs(dir.y) > 0.99) ref.set(1, 0, 0); // avoid a degenerate cross near the poles
    t1.crossVectors(ref, dir).normalize();
    t2.crossVectors(dir, t1); // already unit (dir perpendicular to t1)
    base
      .copy(dir)
      .multiplyScalar(radius)
      .addScaledVector(t1, (rng() * 2 - 1) * BLADE_JITTER)
      .addScaledVector(t2, (rng() * 2 - 1) * BLADE_JITTER)
      .setLength(radius); // snap back onto the surface

    // Draw every blade's randoms up front so the RNG stream stays fixed: carving must only
    // delete pond blades, not reshuffle the rest of the field. carveJitter is drawn here too
    // (unconditionally) for the same reason, even though it only matters at the rim.
    const rot = rng() * Math.PI * 2;
    const h = 0.9 + rng() * 0.6; // ~0.9..1.5 tall
    const ph = rng() * Math.PI * 2;
    const carveJitter = rng(); // 0..1, ragged-shore randomness per blade

    // Carve the pond, but with a ragged edge: each blade's cut line is pulled inward by a random
    // amount, so near the rim the grass thins into a fringe and some blades survive INTO the water
    // (they poke over the waterline and break up the clean bright shoreline ring). A negative margin
    // means "keep this blade even if it sits up to SHORE_FRINGE units inside the water edge".
    const carveMargin = CARVE_MARGIN - carveJitter * SHORE_FRINGE;
    if (pond && pond.contains(base, carveMargin)) continue;
    // Same ragged carve for the dirt road, so grass clears off the path and frays over its edge.
    if (path && path.contains(base, carveMargin)) continue;
    // Clear grass in a small circle under each placed prop, so no blades poke up in front of it.
    let underProp = false;
    for (let f = 0; f < propFootprints.length; f++) {
      if (base.distanceToSquared(propFootprints[f].center) < propFootprints[f].r2) {
        underProp = true;
        break;
      }
    }
    if (underProp) continue;

    aBase[k * 3 + 0] = base.x;
    aBase[k * 3 + 1] = base.y;
    aBase[k * 3 + 2] = base.z;
    aRotation[k] = rot;
    aHeight[k] = h;
    aPhase[k] = ph;
    k++;
  }

  // Size the instanced attributes to the kept blades only (subarray is a view, no copy).
  geo.setAttribute("aBase", new THREE.InstancedBufferAttribute(aBase.subarray(0, k * 3), 3));
  geo.setAttribute("aRotation", new THREE.InstancedBufferAttribute(aRotation.subarray(0, k), 1));
  geo.setAttribute("aHeight", new THREE.InstancedBufferAttribute(aHeight.subarray(0, k), 1));
  geo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(aPhase.subarray(0, k), 1));
  geo.instanceCount = k; // render only the kept blades

  // One static mesh covering the planet; bound to planet radius + tallest blade.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius + 2);
  return geo;
}

const vertexShader = /* glsl */ `
  attribute vec3 aBase;     // world position of this blade's base (on the sphere surface)
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
    vHeight = position.y; // base geom height is 1.0, so y is the height fraction

    // Per-blade surface frame (T, B, N) derived from the base.
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

    // Lighting normal: card normal biased toward up for a soft up-lit look.
    vNormal = normalize(faceAxis * 0.8 + N * 0.6);

    // Wind: project world wind into the tangent plane, bend the tip along it.
    // Two sine octaves + a slow gust, scaled by vHeight so the root stays planted.
    vec3 windT = uWindDir - N * dot(uWindDir, N);
    windT = normalize(windT + 1e-4 * T); // guard if wind ~parallel to N
    float spatial = aBase.x + aBase.y + aBase.z; // varies smoothly over the sphere, no tiling
    float t = uTime * uWindFrequency;
    float wave1 = sin(t + spatial * uWindScale + aPhase);
    float wave2 = sin(t * 1.7 + dot(aBase, vec3(0.7, -1.3, 0.5)) * uWindScale * 2.0 + aPhase * 1.3);
    float wave = wave1 * 0.7 + wave2 * 0.3;
    float gust = 0.6 + 0.4 * sin(uTime * uGustFrequency + spatial * uGustScale);
    float bend = wave * gust * uWindAmplitude * vHeight;
    worldPos += windT * bend;

    // Player parting: blades within radius bend away along the tangent, plus a slight press-down.
    vec3 toBlade = aBase - uPlayerPos;
    float pdist = length(toBlade);
    float influence = 1.0 - smoothstep(0.0, uPlayerRadius, pdist); // 1 near the player, 0 at the radius
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

// Fragment shader: the locked cozy-morning look.
const fragmentShader = /* glsl */ `
  uniform vec3 uBaseColor;
  uniform vec3 uTipColor;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform float uAmbientStrength;
  uniform float uSunStrength;
  uniform float uTipGlow;
  uniform vec3 uHazeColor; // raw sRGB haze (display space), shared with the sky horizon

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
    // Haze blended last, in display space, toward a raw sRGB color, so far grass ends at the
    // same on-screen color as the sky horizon (uHazeColor == sky uHorizon). No tone-map shift.
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, uHazeColor, fogFactor);
  }
`;

// Turn a list of { center, radius } prop footprints into { center, r2 } so the blade loop can compare
// squared distances (no per-blade square root).
function prepFootprints(list: PropFootprint[]): PreppedFootprint[] {
  return list.map((f) => ({ center: f.center, r2: f.radius * f.radius }));
}

// What addGrass hands back. The dev-only editor hides the field and rebuilds the carve on save.
export type Grass = ReturnType<typeof addGrass>;

export function addGrass(
  scene: THREE.Scene,
  target: GrassTarget | null,
  planet: Planet,
  pond: Carve | null,
  path: Carve | null,
  propFootprints: PropFootprint[] = [],
) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uBaseColor: { value: new THREE.Color(COLORS.GRASS_BASE) },
      uTipColor: { value: new THREE.Color(COLORS.GRASS_TIP) },
      uTime: { value: 0 },
      uWindDir: { value: new THREE.Vector3(1, 0, 0.3).normalize() }, // world wind, projected per blade
      uWindFrequency: { value: 1.2 },
      uWindAmplitude: { value: 0.2 },
      uWindScale: { value: 0.3 },
      uGustFrequency: { value: 0.3 },
      uGustScale: { value: 0.05 },
      uPlayerPos: { value: new THREE.Vector3(1e9, 0, 1e9) }, // off-screen until the model loads
      uPlayerRadius: { value: 1.8 }, // parting radius around the character
      uPlayerStrength: { value: 0.4 }, // how far tips bend away (subtle)
      uSunDir: { value: new THREE.Vector3(5, 5, 4).normalize() }, // mid-morning angle (match lights.js + sunFollow)
      uSunColor: { value: new THREE.Color(COLORS.SUN) },
      uSkyColor: { value: new THREE.Color(COLORS.SKY) },
      uAmbientStrength: { value: 0.5 },
      uSunStrength: { value: 0.8 },
      uTipGlow: { value: 0.22 },
      uHazeColor: { value: new THREE.Vector3(...srgb(COLORS.FOG)) }, // raw sRGB haze, matches sky horizon
      // fogNear/fogFar auto-update from scene.fog because fog:true (we do our own blend).
      fogColor: { value: new THREE.Color() },
      fogNear: { value: 1 },
      fogFar: { value: 1000 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    fog: true,
  });

  const geo = buildGrassGeometry(planet.radius, pond, path, prepFootprints(propFootprints));
  const mesh = new THREE.Mesh(geo, material);
  scene.add(mesh);

  return {
    update(dt: number) {
      material.uniforms.uTime.value += dt;
      if (target && target.model) {
        material.uniforms.uPlayerPos.value.copy(target.model.position); // grass parts around him
      }
    },
    setVisible(v: boolean) {
      mesh.visible = v; // the editor hides the grass in editor mode
    },
    // Rebuild the whole blade field with a new set of prop footprints (called when props move on save).
    // Heavy (regenerates every blade), so only ever on an explicit save, never per frame.
    rebuild(list: PropFootprint[]) {
      const newGeo = buildGrassGeometry(planet.radius, pond, path, prepFootprints(list));
      mesh.geometry.dispose();
      mesh.geometry = newGeo;
    },
  };
}
