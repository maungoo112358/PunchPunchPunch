import * as THREE from "three";
import { COLORS } from "../config/palette.js";

// ---------------------------------------------------------------------------
// CHUNKED GPU grass. The world is a grid of square chunks; we keep a (2R+1)^2
// grid centered on the player and recycle chunks as he moves (object pooling).
// Each chunk is its own frustum-culled mesh (off-screen chunks cost nothing),
// and distant chunks draw fewer blades (LOD). Wind + lighting shaders unchanged.
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 12; // world units per chunk tile
const GRID_RADIUS = 3; // chunks each side of the player → (2R+1)^2 = 49 chunks
const BLADES_PER_CHUNK = 10000; // full-density capacity per chunk

// LOD: fraction of a chunk's blades to draw, by ring distance from the player.
function lodFraction(ring) {
  if (ring <= 1) return 1.0; // near: full density
  if (ring === 2) return 0.5; // mid
  return 0.25; // far: sparse (tiny on screen, invisible)
}

// Tiny seeded RNG so each chunk's layout is deterministic from its coordinate
// (stable if the player walks back to it) and chunks don't look identical.
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
const BLADE_POSITIONS = new Float32Array([
  -0.05, 0.0, 0.0, 0.05, 0.0, 0.0, -0.04, 0.33, 0.0, 0.04, 0.33, 0.0, -0.025,
  0.66, 0.0, 0.025, 0.66, 0.0, 0.0, 1.0, 0.0,
]);
const BLADE_INDICES = [0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5, 4, 5, 6];

// Allocate a chunk geometry (instance buffers empty until assigned to a coord).
function buildChunkGeometry() {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(BLADE_POSITIONS, 3));
  geo.setIndex(BLADE_INDICES);
  geo.setAttribute("aPosition", new THREE.InstancedBufferAttribute(new Float32Array(BLADES_PER_CHUNK * 3), 3));
  geo.setAttribute("aRotation", new THREE.InstancedBufferAttribute(new Float32Array(BLADES_PER_CHUNK), 1));
  geo.setAttribute("aHeight", new THREE.InstancedBufferAttribute(new Float32Array(BLADES_PER_CHUNK), 1));
  geo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(new Float32Array(BLADES_PER_CHUNK), 1));
  // Set the bounding sphere ourselves (covers the tile) so Three frustum-culls the
  // whole chunk instead of computing a tiny sphere from the base blade.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), CHUNK_SIZE * 0.9);
  return geo;
}

// Move + repopulate a chunk to world coordinate (cx, cz). Blade positions are
// stored in WORLD space (mesh stays at origin), so the wind shader samples world
// coords directly and the field never visibly tiles.
function assignChunk(chunk, cx, cz, path) {
  chunk.cx = cx;
  chunk.cz = cz;
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  const rng = mulberry32((Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) >>> 0);

  const geo = chunk.geo;
  const aPos = geo.attributes.aPosition;
  const aRot = geo.attributes.aRotation;
  const aHt = geo.attributes.aHeight;
  const aPh = geo.attributes.aPhase;
  for (let i = 0; i < BLADES_PER_CHUNK; i++) {
    const bx = ox + rng() * CHUNK_SIZE;
    const bz = oz + rng() * CHUNK_SIZE;
    aPos.array[i * 3 + 0] = bx;
    aPos.array[i * 3 + 1] = 0;
    aPos.array[i * 3 + 2] = bz;
    aRot.array[i] = rng() * Math.PI * 2;
    // Always consume the height RNG (keeps layouts deterministic), but zero it out for
    // blades on the path so the strip reads as bare ground.
    const h = 0.9 + rng() * 0.6; // ~0.9..1.5 tall
    aHt.array[i] = path && path.onPath(bx, bz) ? 0 : h;
    aPh.array[i] = rng() * Math.PI * 2;
  }
  aPos.needsUpdate = true;
  aRot.needsUpdate = true;
  aHt.needsUpdate = true;
  aPh.needsUpdate = true;

  geo.boundingSphere.center.set(ox + CHUNK_SIZE / 2, 1, oz + CHUNK_SIZE / 2);
}

const vertexShader = /* glsl */ `
  attribute vec3 aPosition; // WORLD position of this blade's base
  attribute float aRotation;
  attribute float aHeight;
  attribute float aPhase;

  varying float vHeight;
  varying vec3 vNormal;

  uniform float uTime;
  uniform vec2 uWindDir;
  uniform float uWindFrequency;
  uniform float uWindAmplitude;
  uniform float uWindScale;
  uniform float uGustFrequency;
  uniform float uGustScale;

  uniform vec3 uPlayerPos; // character world position
  uniform float uPlayerRadius; // how far the parting reaches
  uniform float uPlayerStrength; // how far blades bend away

  #include <fog_pars_vertex>

  void main() {
    vHeight = position.y; // base geom height is 1.0, so y IS the height fraction

    vec3 pos = position;
    pos.y *= aHeight;

    float s = sin(aRotation);
    float c = cos(aRotation);
    vec3 spun = vec3(pos.x * c + pos.z * s, pos.y, -pos.x * s + pos.z * c);

    vNormal = normalize(vec3(s, 0.6, c)); // up-biased blade normal for sun shading

    vec3 worldPos = spun + aPosition;

    // WIND: two sine octaves + a slow gust envelope, scaled by vHeight (root planted).
    float t = uTime * uWindFrequency;
    float wave1 = sin(t + (worldPos.x + worldPos.z) * uWindScale + aPhase);
    float wave2 = sin(t * 1.7 + (worldPos.x * 0.7 - worldPos.z * 1.3) * uWindScale * 2.0 + aPhase * 1.3);
    float wave = wave1 * 0.7 + wave2 * 0.3;
    float gust = 0.6 + 0.4 * sin(uTime * uGustFrequency + (worldPos.x + worldPos.z) * uGustScale);
    float bend = wave * gust * uWindAmplitude * vHeight;
    worldPos.x += bend * uWindDir.x;
    worldPos.z += bend * uWindDir.y;

    // PLAYER DISPLACEMENT: blades within radius bend AWAY from the character. Scaled
    // by vHeight so roots stay planted and tips part; a little press-down underfoot.
    vec2 toBlade = worldPos.xz - uPlayerPos.xz;
    float pdist = length(toBlade);
    float influence = 1.0 - smoothstep(0.0, uPlayerRadius, pdist); // 1 near → 0 at radius
    vec2 pushDir = pdist > 0.001 ? toBlade / pdist : vec2(0.0);
    float push = influence * uPlayerStrength * vHeight;
    worldPos.x += pushDir.x * push;
    worldPos.z += pushDir.y * push;
    worldPos.y -= push * 0.35; // slight trample/flatten near his feet

    vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uBaseColor;
  uniform vec3 uTipColor;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform float uAmbientStrength;
  uniform float uSunStrength;
  uniform float uTipGlow;

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
    #include <fog_fragment>
  }
`;

export function addGrass(scene, target, path) {
  // One material shared by every chunk (blade positions carry their own world pos).
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uBaseColor: { value: new THREE.Color(COLORS.GRASS_BASE) },
      uTipColor: { value: new THREE.Color(COLORS.GRASS_TIP) },
      uTime: { value: 0 },
      uWindDir: { value: new THREE.Vector2(1, 0.3).normalize() },
      uWindFrequency: { value: 1.2 },
      uWindAmplitude: { value: 0.2 },
      uWindScale: { value: 0.3 },
      uGustFrequency: { value: 0.3 },
      uGustScale: { value: 0.05 },
      uPlayerPos: { value: new THREE.Vector3(1e9, 0, 1e9) }, // off in the void until the model loads
      uPlayerRadius: { value: 1.8 }, // parting radius around the character
      uPlayerStrength: { value: 0.4 }, // how far tips bend away (subtle part, not a blast)
      uSunDir: { value: new THREE.Vector3(3, 4, 5).normalize() },
      uSunColor: { value: new THREE.Color(COLORS.SUN) },
      uSkyColor: { value: new THREE.Color(COLORS.SKY) },
      uAmbientStrength: { value: 0.5 }, // blue sky fill raised so the night blue bleeds in
      uSunStrength: { value: 0.6 }, // cool moonlight key lowered so ambient dominates
      uTipGlow: { value: 0.12 },
      // Fog uniforms — the renderer auto-updates these from scene.fog because fog:true.
      fogColor: { value: new THREE.Color() },
      fogNear: { value: 1 },
      fogFar: { value: 1000 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    fog: true,
  });

  // Build the chunk pool.
  const pool = [];
  const total = (GRID_RADIUS * 2 + 1) ** 2;
  for (let i = 0; i < total; i++) {
    const geo = buildChunkGeometry();
    const mesh = new THREE.Mesh(geo, material); // mesh stays at origin; positions are world-space
    mesh.frustumCulled = true; // off-screen chunks are skipped
    scene.add(mesh);
    pool.push({ mesh, geo, cx: null, cz: null });
  }

  const active = new Map(); // "cx,cz" -> chunk
  const free = [...pool]; // chunks available for assignment (starts as the whole pool)
  let lastPcx = null;
  let lastPcz = null;

  // Re-center the grid on the player's chunk: free chunks that left the grid,
  // reassign them to newly-needed coords, and set each chunk's LOD by ring.
  function refreshGrid(pcx, pcz) {
    const needed = new Set();
    const desired = [];
    for (let dz = -GRID_RADIUS; dz <= GRID_RADIUS; dz++) {
      for (let dx = -GRID_RADIUS; dx <= GRID_RADIUS; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        const key = cx + "," + cz;
        needed.add(key);
        desired.push({ cx, cz, key, ring: Math.max(Math.abs(dx), Math.abs(dz)) });
      }
    }

    for (const [key, chunk] of active) {
      if (!needed.has(key)) {
        active.delete(key);
        free.push(chunk); // return chunks that left the grid to the pool
      }
    }

    for (const d of desired) {
      let chunk = active.get(d.key);
      if (!chunk) {
        chunk = free.pop();
        assignChunk(chunk, d.cx, d.cz, path); // only newly-entered chunks repopulate
        active.set(d.key, chunk);
      }
      chunk.geo.instanceCount = Math.floor(BLADES_PER_CHUNK * lodFraction(d.ring));
    }
  }

  // Seed the grid around the origin so grass shows before the model loads.
  refreshGrid(0, 0);
  lastPcx = 0;
  lastPcz = 0;

  return {
    update(dt) {
      material.uniforms.uTime.value += dt;
      if (target && target.model) {
        const p = target.model.position;
        material.uniforms.uPlayerPos.value.copy(p); // grass parts around him
        const pcx = Math.floor(p.x / CHUNK_SIZE);
        const pcz = Math.floor(p.z / CHUNK_SIZE);
        if (pcx !== lastPcx || pcz !== lastPcz) {
          refreshGrid(pcx, pcz); // only on chunk-boundary crossings
          lastPcx = pcx;
          lastPcz = pcz;
        }
      }
    },
  };
}
