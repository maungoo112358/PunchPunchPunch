import * as THREE from "three";
import { COLORS, srgb } from "../config/palette.js";
import type { Planet } from "./planet.js";
// "?raw" is a Vite thing: it hands you the file's text as a plain string instead of trying to run it,
// which is exactly what a ShaderMaterial wants.
import vertexShader from "../shaders/grass.vert?raw";
import fragmentShader from "../shaders/grass.frag?raw";

// Whole-sphere GPU grass.
// The planet is finite, so every blade is scattered over the whole sphere once, with no streaming.
// The opaque planet hides the back half, so only about half the blades are ever visible.
// Each blade has its own up, the surface normal, so grass.vert builds it in a per-blade frame (T, B, N).
// Wind and player parting both work in that surface frame.

const BLADE_COUNT = 400000; // total blades, tune by eye and FPS
const BLADE_JITTER = 0.13; // random sideways nudge, so the Fibonacci spiral does not read as rows
const CARVE_MARGIN = 0.0; // base cut line: grass reaches the exact road edge, the fringe adds the poke
const SHORE_FRINGE = 0.7; // how far a blade can randomly poke IN over the road, rolled per blade

// The dirt road answers a simple question: is this spot inside me? Grass asks that to clear blades off
// the path. It is a shape, not a named class, so anything with a contains() fits here. In TypeScript
// matching the shape is all it takes.
type Carve = { contains(worldPos: THREE.Vector3, margin?: number): boolean };

// A circle of cleared ground under a prop, the way the caller hands it to us.
type PropFootprint = { center: THREE.Vector3; radius: number };

// The same circle with the radius already squared, so the blade loop can compare squared distances and
// skip a square root on every one of the 400,000 blades.
type PreppedFootprint = { center: THREE.Vector3; r2: number };

// The character, so the grass can part around him. Null until the glTF finishes loading.
type GrassTarget = { model: THREE.Object3D | null };

// Seeded random: one fixed sequence handed out in order, the same every reload.
// buildGrassGeometry leans on that, because carving must only delete blades and never reshuffle the field.
// Math.random() would give a different field every load and could not be reproduced, so it cannot be used
// here at all.
// The bit math inside is the published mulberry32 algorithm and is not meant to be read. It stirs the bits
// of a counter and returns the result as a 0 to 1 float. Fast, tiny, good enough spread for scattering.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One blade: 7 points, 5 triangles, flat in x and y with z always 0.
// x is width, y is height, and the height is baked to exactly 1.0, so local y is the height fraction:
// 0 at the root, 1 at the tip. grass.vert rotates this flat shape into the surface frame at aBase.
const BLADE_POSITIONS = new Float32Array([
  -0.05, 0.0, 0.0, 0.05, 0.0, 0.0, -0.04, 0.33, 0.0, 0.04, 0.33, 0.0, -0.025,
  0.66, 0.0, 0.025, 0.66, 0.0, 0.0, 1.0, 0.0,
]);
const BLADE_INDICES = [0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5, 4, 5, 6];

// Places every blade, drops the ones on the road or under a prop, packs the survivors into GPU arrays.
//
// The bases are scattered with a Fibonacci spiral: step down the sphere in equal height slices and turn
// 137.5 degrees each step.
// Equal steps in height, not in latitude angle, is what spreads them evenly. Slice a ball like bread and
// every slice carries the same amount of skin: near the top the circle is small but the surface is steeply
// slanted, in the middle the circle is big but the wall is near vertical, and the two cancel exactly.
// Equal steps in latitude angle do not cancel, which is why a lat/long grid clumps thick at the poles.
// 137.5 degrees is a full turn divided by the golden ratio squared, the hardest number to approximate with
// a fraction, so the sequence never closes on itself and each blade drops into the biggest gap left.
// A clean fraction of a circle, 90 or 120 degrees, would land blades on top of earlier ones and stack them
// into visible spokes. Sunflowers pack seeds this way.
function buildGrassGeometry( radius: number, path: Carve | null, propFootprints: PreppedFootprint[], ){
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(BLADE_POSITIONS, 3));
  geo.setIndex(BLADE_INDICES);

  // One shape, 400,000 copies, each carrying four values of its own.
  // Six floats per blade instead of a whole mesh, which is what makes the count affordable.
  const aBase = new Float32Array(BLADE_COUNT * 3); // where it stands
  const aRotation = new Float32Array(BLADE_COUNT); // spin around its own up
  const aHeight = new Float32Array(BLADE_COUNT); // real height, multiplies the baked 1.0
  const aPhase = new Float32Array(BLADE_COUNT); // offset into the wind waves

  const rng = mulberry32(0xc0ffee);
  const golden = Math.PI * (3 - Math.sqrt(5)); // 2.39996 rad, 137.5 degrees
  const dir = new THREE.Vector3();
  const t1 = new THREE.Vector3();
  const t2 = new THREE.Vector3();
  const ref = new THREE.Vector3();
  const base = new THREE.Vector3();

  let k = 0; // write index for kept blades, so the arrays fill densely from 0
  for (let i = 0; i < BLADE_COUNT; i++) {
    // (i + 0.5) / BLADE_COUNT turns the blade number into a fraction, 0 to 1.
    // * 2 stretches it to a span of 2, and 1 - flips it to run +1 down to -1.
    // Those are the top and bottom of a unit sphere, so blade 0 lands near the north pole.
    // + 0.5 centers each blade in its slice instead of on the top edge.
    // Without it blade 0 sits at exactly y = 1, where the ring below has shrunk to a point and the
    // sideways math has nothing to work with, and the last blade stops short of -1, so the south pole
    // gets a gap and the north gets none. With it both ends land at ±0.9999975.
    const y = 1 - ((i + 0.5) / BLADE_COUNT) * 2;

    // How wide the sphere is at that height. x² + y² + z² = 1 on a unit sphere and x² + z² is the ring's
    // radius squared, so r = √(1 - y²). 1 at the equator, 0 at a pole.
    // Math.max(0, ...) is a float guard: y a hair past 1 makes 1 - y*y negative and sqrt gives NaN, and a
    // NaN blade renders as nothing.
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i; // each blade turns 137.5 degrees further around than the one before
    // A height and an angle around a ring of radius r, placed the usual way.
    // Length comes out 1 for free, since r²cos² + y² + r²sin² is r² + y² is 1.
    // So this is a direction from the planet center, not a position yet.
    dir.set(Math.cos(theta) * r, y, Math.sin(theta) * r);

    // The spiral is even but regular, and up close you can see its rows, so nudge each blade sideways.
    // Sideways is anything perpendicular to dir, and a cross product returns exactly that.
    // t1 and t2 are two of those at right angles, covering every sideways direction.
    // The ref swap is a guard: crossing two parallel vectors gives zero, and normalizing zero gives NaN.
    // Near the poles dir is almost (0, ±1, 0), nearly parallel to the default ref, so the cross gets tiny
    // and loses precision before it ever reaches exact zero. Hence the swap at 0.99, not at exactly parallel.
    ref.set(0, 1, 0);
    if (Math.abs(dir.y) > 0.99) ref.set(1, 0, 0);
    t1.crossVectors(ref, dir).normalize();
    t2.crossVectors(dir, t1); // dir and t1 are unit and perpendicular, so this comes out unit already

    // multiplyScalar(radius) turns the direction into a position on the surface.
    // rng() * 2 - 1 remaps rng()'s 0 to 1 into -1 to +1, so the nudge goes both ways.
    // The nudges travel along the flat plane that only touches the sphere, leaving the blade floating
    // slightly outside it, so setLength keeps the direction and resets the distance to put it back down.
    base
      .copy(dir)
      .multiplyScalar(radius)
      .addScaledVector(t1, (rng() * 2 - 1) * BLADE_JITTER)
      .addScaledVector(t2, (rng() * 2 - 1) * BLADE_JITTER)
      .setLength(radius);

    // Every blade draws its four randoms here, before either carve test, even ones about to be deleted.
    // rng hands out one fixed sequence in order, so a skipped draw would shift every blade after it onto
    // its neighbour's numbers and reshuffle the whole field the moment you move one prop.
    // Drawing unconditionally ties the numbers to the blade index, so carving only ever deletes.
    const rot = rng() * Math.PI * 2;
    const h = 0.9 + rng() * 0.6; // 0.9 to 1.5 tall
    const ph = rng() * Math.PI * 2;
    const carveJitter = rng(); // 0 to 1, this blade's own ragged-edge roll

    // path.contains asks "is this spot on the road", and the margin moves the edge it tests against.
    // Negative shrinks the road, so the blade survives standing up to SHORE_FRINGE inside the real edge.
    // Every blade rolls its own margin, so the cut line sits somewhere different for each one.
    // Deep in the road they all go, near the rim it is a coin flip weighted by how far in they sit.
    // The grass thins into a fringe over the last 0.7 units instead of stopping at a machined line.
    const carveMargin = CARVE_MARGIN - carveJitter * SHORE_FRINGE;
    if (path && path.contains(base, carveMargin)) continue;

    // Clear a circle under each placed prop, so no blades poke up through a rock or a tree.
    // Squared distance against a pre-squared radius, because a < b and a² < b² agree for positive numbers.
    // That skips a square root per prop per blade, and this runs over every prop for all 400,000.
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

  // The arrays were sized for the full 400,000 but only k slots got written.
  // subarray is a window onto the same memory with no copy, so the GPU gets exactly the used part.
  geo.setAttribute("aBase", new THREE.InstancedBufferAttribute(aBase.subarray(0, k * 3), 3));
  geo.setAttribute("aRotation", new THREE.InstancedBufferAttribute(aRotation.subarray(0, k), 1));
  geo.setAttribute("aHeight", new THREE.InstancedBufferAttribute(aHeight.subarray(0, k), 1));
  geo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(aPhase.subarray(0, k), 1));
  geo.instanceCount = k; // stops it drawing the empty tail

  // Set by hand, because Three would work it out from the position attribute: one 1-unit blade at the
  // origin, since the real positions live in an instanced attribute it does not read.
  // It would call the whole field a tiny ball at the center, decide it is off-screen, and skip the grass.
  // radius + 2 covers the planet plus the tallest blade at 1.5, with slack for the wind bend.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius + 2);
  return geo;
}

// Squares each prop radius once up front, so the blade loop compares squared distances and never takes a
// square root. Same answer, far cheaper at 400,000 blades times however many props.
function prepFootprints(list: PropFootprint[]): PreppedFootprint[] {
  return list.map((f) => ({ center: f.center, r2: f.radius * f.radius }));
}

// What addGrass hands back. The dev-only editor hides the field and rebuilds the carve on save.
export type Grass = ReturnType<typeof addGrass>;

// Builds the grass once and hands back the only three controls the rest of the game needs.
// A factory rather than a class, because setup happens once. The material, geometry and mesh stay inside
// the closure, so nothing outside can reach them.
// The material is custom because no stock Three material can bend 400,000 blades in the wind or part them
// around a player. That is all hand-written math in grass.vert and grass.frag.
export function addGrass( scene: THREE.Scene, target: GrassTarget | null, planet: Planet, path: Carve | null, propFootprints: PropFootprint[] = [], ) {
  // The uniforms object is the whole interface between JS and the GPU.
  // Every key here pairs with a uniform line in grass.vert or grass.frag, matched by name at runtime.
  // Rename one on either side and nothing errors: the shader reads a default and the effect quietly dies.
  // These are starting values. update() moves uTime and uPlayerPos every frame, the rest are dials.
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uBaseColor: { value: new THREE.Color(COLORS.GRASS_BASE) }, // root color
      uTipColor: { value: new THREE.Color(COLORS.GRASS_TIP) }, // tip color, mixed in by height
      uTime: { value: 0 }, // wind clock, advanced by update()

      // None of the wind numbers are in obvious units, so here is what they work out to on a radius 36
      // planet. grass.vert adds up a blade's three coordinates into "spatial", which runs -62 to +62.
      uWindDir: { value: new THREE.Vector3(1, 0, 0.3).normalize() }, // one world direction, flattened per blade
      uWindFrequency: { value: 1.2 }, // time scale: the lead wave cycles every 5.2s, the second every 3.1s
      uWindAmplitude: { value: 0.2 }, // sideways travel of the tip in world units, about a 9 degree lean
      uWindScale: { value: 0.3 }, // ripple size: 125 of span × 0.3 / 2π, so about 6 crests across the planet
      uGustFrequency: { value: 0.3 }, // the gust breathes every 21s, swinging strength between 0.2 and 1.0
      uGustScale: { value: 0.05 }, // gust size: same span × 0.05, about 1 crest, one front over the planet
      // 6 ripples against 1 gust is the whole effect, small waves riding one big swell.
      // Bring those two scales together and the wind collapses into a single flat texture.

      // Parked absurdly far out, because the glTF loads async and target.model is null for the first few
      // frames. Left at the default (0,0,0) the blades around the planet's center-facing side would part
      // around a character who is not there yet.
      uPlayerPos: { value: new THREE.Vector3(1e9, 0, 1e9) },
      uPlayerRadius: { value: 1.8 }, // how far the parting reaches, in world units
      uPlayerStrength: { value: 0.4 }, // how far the tips bend away, kept subtle

      // Must match lights.ts and sunFollow. Nothing enforces it, so moving the sun in one place leaves the
      // grass lit from the old angle and nothing will tell you.
      uSunDir: { value: new THREE.Vector3(5, 5, 4).normalize() }, // mid-morning angle
      uSunColor: { value: new THREE.Color(COLORS.SUN) },
      uSkyColor: { value: new THREE.Color(COLORS.SKY) }, // flat fill, the frag uses it as ambient
      uAmbientStrength: { value: 0.5 }, // how much of that flat fill lands, so nothing reads as pure black
      uSunStrength: { value: 0.8 }, // how much the sun term adds on top
      uTipGlow: { value: 0.22 }, // extra brightness on the top of a blade, faking light through the thin tip
      uHazeColor: { value: new THREE.Vector3(...srgb(COLORS.FOG)) }, // must equal the sky's horizon color

      // fog:true does not turn Three's fog on for us in any real sense, because the frag never reads
      // fogColor and blends toward uHazeColor instead. What it buys is the plumbing: Three keeps fogNear
      // and fogFar synced from scene.fog every frame and injects vFogDepth. We take the pipe and throw
      // away the water. fogColor is only declared because Three's shader chunk expects it to exist.
      fogColor: { value: new THREE.Color() },
      fogNear: { value: 1 },
      fogFar: { value: 1000 },
    },
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide, // a blade is a flat card with no back, so both faces have to draw
    fog: true,
  });

  const geo = buildGrassGeometry(planet.radius, path, prepFootprints(propFootprints));
  const mesh = new THREE.Mesh(geo, material);
  scene.add(mesh);

  return {
    // The only part that runs every frame.
    // uTime accumulates from dt instead of reading a global clock, so if dt goes to zero the wind freezes
    // along with everything else.
    // target.model stays null until the glTF lands, which is what uPlayerPos is parked far away for.
    update(dt: number) {
      material.uniforms.uTime.value += dt;
      if (target && target.model) {
        material.uniforms.uPlayerPos.value.copy(target.model.position); // grass parts around him
      }
    },
    setVisible(v: boolean) {
      mesh.visible = v; // the prop editor hides the grass to see the bare ground
    },
    // Throws away every blade and lays them all out again with new prop footprints.
    // Replaces the geometry but keeps the same material, so any uniform tweaked at runtime survives.
    // Heavy, so it only ever runs on an explicit editor save, never per frame.
    rebuild(list: PropFootprint[]) {
      const newGeo = buildGrassGeometry(planet.radius, path, prepFootprints(list));
      mesh.geometry.dispose();
      mesh.geometry = newGeo;
    },
  };
}
