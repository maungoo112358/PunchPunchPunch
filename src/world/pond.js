import * as THREE from "three";
import { COLORS } from "../config/palette.js";

// Depth-based pond, built as REAL geometry. See docs/POND_IMPLEMENTATION.md for the full plan.
//
// STEP 1 (current): geometry only, no shader effects.
//   - BED (bowl): a basin dug into the planet, deep in the middle, rising to the rim.
//   - WATER: a flat surface sitting in the bowl, a bit below the surrounding grass.
//   - DENT: push the planet's own surface down under the pond so its cap can't cover the bowl.
// The idea: give the water a real bed that rises to the shore, so later steps can read water
// THICKNESS (surface-to-bed distance) from a depth buffer and get shallow color + foam for free.

// --- Placement ---
const POND_DIR = new THREE.Vector3(0, 0.94, 0.34).normalize(); // ~20 deg off the north pole (spawn)
const POND_RADIUS = 5; // pond radius across the surface (world units), before the organic wobble
const POND_RINGS = 24; // radial subdivisions of the bowl/water discs (more = smoother bowl)
const POND_SEGMENTS = 64; // subdivisions around the disc (more = rounder outline)
const POND_WOBBLE = 0.2; // outline lumpiness (0 = perfect circle)

// --- Depths (all measured inward from the planet surface radius) ---
const BED_DEPTH = 2.0; // how deep the bowl center sits below the rim
const WATER_DROP = 0.6; // how far the water surface sits below the surrounding grass line
const DENT_EXTRA = 2.0; // how far BELOW the bowl we push the planet cap so it can't cover the pond
const DENT_MARGIN = 1.0; // dent planet verts a bit past the rim so no green cap peeks inside
const BOWL_LIP_REACH = 0.6; // how far the bowl's lip reaches out over the ground (covers the gap at the edge)
const BOWL_LIP_HEIGHT = 0.03; // how much the lip is raised so it sits on top of the ground and doesn't flicker

// Placeholder bed color for step 1 (a muddy sand). Promote to palette once the look is settled.
const BED_COLOR = 0x7a6547;

// Three waves added together make the lumpy edge. Each wave has three knobs:
//   STRENGTH = how far it pushes the edge in/out
//   BUMPS    = how many in/out bulges it makes going around (whole numbers only, so the edge joins cleanly)
//   ROT      = spins the wave so the three don't line up on top of each other
const WAVE1_STRENGTH = 0.6, WAVE1_BUMPS = 2.0, WAVE1_ROT = 0.7;
const WAVE2_STRENGTH = 0.3, WAVE2_BUMPS = 3.0, WAVE2_ROT = 2.1;
const WAVE3_STRENGTH = 0.2, WAVE3_BUMPS = 5.0, WAVE3_ROT = 4.3;

// Returns the distance from the pond center (origin) to an edge point in a given direction.
// buildCapDisc uses that distance to place each mesh point.
// The bowl, water, and grass carve all call this, so their edges match.
function pondRadiusAt(theta) {
  const wob =
    WAVE1_STRENGTH * Math.sin(theta * WAVE1_BUMPS + WAVE1_ROT) +
    WAVE2_STRENGTH * Math.sin(theta * WAVE2_BUMPS + WAVE2_ROT) +
    WAVE3_STRENGTH * Math.sin(theta * WAVE3_BUMPS + WAVE3_ROT);
  const FULL_CIRCLE = 1.0; // the plain circle (full radius). do not change; POND_WOBBLE * wob pushes the edge in/out around it.
  return POND_RADIUS * (FULL_CIRCLE + POND_WOBBLE * wob);
}

// Builds the shape data (points + triangles) for a pond disc laid on the sphere.
// The same builder makes BOTH the bowl (bed) and the flat water; depthFn decides which.
// depthFn(f): f is 0 at the center, 1 at the edge, and it returns how far that ring sits
// BELOW the planet surface. Constant depthFn = flat (that's the water). A bowl curve =
// deep in the middle rising to the rim (that's the basin/bed).
function buildCapDisc(planetRadius, center, tWorld, bWorld, normal, depthFn, lip = 0, lift = 0) {
  const rings = POND_RINGS;
  const segments = POND_SEGMENTS;
  const positions = [];
  const uvs = [];
  const indices = [];
  const p = new THREE.Vector3();

  // Places one full ring of points around the pond. For each point: distanceOutAt(angle) says how far
  // out it sits from the pond center, height says how far it sits from the planet center (its depth),
  // and uvr is its texture-coordinate distance from the center. Both the bowl rings and the lip use this.
  function placeRing(distanceOutAt, height, uvr) {
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const distanceOut = distanceOutAt(angle);
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
     p.copy(center) .addScaledVector(tWorld, ca * distanceOut) .addScaledVector(bWorld, sa * distanceOut) .setLength(height);
      positions.push(p.x, p.y, p.z);
      uvs.push(0.5 + ca * uvr, 0.5 + sa * uvr);
    }
  }

  // This creates the one center point of the disc — the single point in the middle, and the first
  // point of the mesh. Every other point gets built around it. It places that point by pointing
  // straight out toward the pond and pushing out to the surface, minus how deep the center sits.
  p.copy(normal).multiplyScalar(planetRadius - depthFn(0));
  positions.push(p.x, p.y, p.z);
  uvs.push(0.5, 0.5);

  // Generate all the other points the mesh is built from, going ring by ring and around each ring.
  // This step only makes the points. It does not connect them into triangles yet. That happens after
  // this loop, in the sections below (the fan and the quad strips), which take these points and join
  // them into triangles.
  for (let j = 1; j <= rings; j++) {
    const f = j / rings;
    // Each ring: how far out = the wobbly edge scaled inward by f; height = surface minus this ring's
    // depth; uv distance = 0.5 * f. The little function for the distance is the only part that
    // differs from the lip below.
    placeRing((angle) => pondRadiusAt(angle) * f, planetRadius - depthFn(f), 0.5 * f);
  }

  // Inner fan: center vertex to the first ring.
  for (let i = 0; i < segments; i++) {
    indices.push(0, 1 + i, 1 + ((i + 1) % segments));
  }
  // Connect the points into triangles, filling the band between each ring and the next one out.
  // The graphics card only draws triangles, so for every four-sided patch between two rings we make
  // two triangles. Do that all the way around, for every ring pair, and the whole surface is solid.
  for (let j = 1; j < rings; j++) {
    const curr = 1 + (j - 1) * segments; // number of the first point of the current (inner) ring
    const next = 1 + j * segments; // number of the first point of the next (outer) ring
    for (let i = 0; i < segments; i++) {
      const i2 = (i + 1) % segments; // the next point around; the wrap (% segments) closes the circle so there is no gap
      // two triangles fill one four-sided patch between the rings
      indices.push(curr + i, next + i, next + i2);
      indices.push(curr + i, next + i2, curr + i2);
    }
  }

  // If this disc has a lip, build it here. The lip is a flat ring reaching just past the rim, laid
  // over the ground so the bowl's edge has no gap to see through.
  if (lip > 0) {
    const outer = 1 + (rings - 1) * segments; // first point of the bowl's outer (rim) ring
    const lipStart = 1 + rings * segments; // first point of the lip ring we make next

    // First, make the points for the lip.
    placeRing((angle) => pondRadiusAt(angle) + lip, planetRadius + lift, 0.5);

    // Then connect those points into triangles.
    for (let i = 0; i < segments; i++) {
      const i2 = (i + 1) % segments;
      indices.push(outer + i, lipStart + i, lipStart + i2);
      indices.push(outer + i, lipStart + i2, outer + i2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// Push the planet's own verts that fall inside the pond footprint down below the bowl, so the coarse
// planet cap can't cover the fine bed mesh. It stays hidden under the bed + the grass at the rim.
function dentPlanet(planet, center, tWorld, bWorld) {
  const pos = planet.mesh.geometry.attributes.position;
  const floorRadius = planet.radius - BED_DEPTH - DENT_EXTRA;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const x = v.dot(tWorld) - center.dot(tWorld);
    const y = v.dot(bWorld) - center.dot(bWorld);
    const dist = Math.hypot(x, y);
    if (dist < pondRadiusAt(Math.atan2(y, x)) + DENT_MARGIN) {
      v.setLength(floorRadius);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
  }
  pos.needsUpdate = true;
  planet.mesh.geometry.computeVertexNormals();
}

export function createPond(scene, planet) {
  // Pond center on the surface, its up (surface normal == dir here), and a tangent frame (tWorld,
  // bWorld) so local disc angles map to fixed world directions. The grass carve reuses this frame.
  const normal = POND_DIR.clone();
  const center = normal.clone().multiplyScalar(planet.radius);
  const ref = Math.abs(normal.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const tWorld = new THREE.Vector3().crossVectors(ref, normal).normalize();
  const bWorld = new THREE.Vector3().crossVectors(normal, tWorld);

  // Sink the planet cap first so the bed shows.
  dentPlanet(planet, center, tWorld, bWorld);

  // Bed: a bowl, deep at the center, rising to the rim (depth 0 at f=1), plus an outward flange that
  // laps over the ground to seal the rim. DoubleSide so you can never see through its back.
  const bedGeo = buildCapDisc(
    planet.radius, center, tWorld, bWorld, normal,
    (f) => BED_DEPTH * (1 - f * f),
    BOWL_LIP_REACH, BOWL_LIP_HEIGHT,
  );
  const bedMat = new THREE.MeshStandardMaterial({ color: BED_COLOR, roughness: 0.95, side: THREE.DoubleSide });
  const bed = new THREE.Mesh(bedGeo, bedMat);
  bed.receiveShadow = true;
  scene.add(bed);

  // Water: a level cap (constant depth) sitting WATER_DROP below the grass line. Opaque + DoubleSide
  // for now so the seal is easy to judge (no seeing through it). The real water shader arrives later.
  const waterGeo = buildCapDisc(planet.radius, center, tWorld, bWorld, normal, () => WATER_DROP);
  const waterMat = new THREE.MeshBasicMaterial({ color: COLORS.WATER_DEEP, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(waterGeo, waterMat);
  scene.add(mesh);

  // Is a world point inside the pond footprint (+ margin)? Project into the pond frame, get angle +
  // distance, compare against the organic rim. The grass carve calls this to clear blades.
  const tmp = new THREE.Vector3();
  function contains(worldPos, margin = 0) {
    tmp.copy(worldPos).sub(center);
    const x = tmp.dot(tWorld);
    const y = tmp.dot(bWorld);
    const dist = Math.hypot(x, y);
    return dist < pondRadiusAt(Math.atan2(y, x)) + margin;
  }

 return { mesh, bed, center, radius: POND_RADIUS, contains, update() {}, };
}
