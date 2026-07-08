import * as THREE from "three";

// A dirt walking path: one closed loop that wanders once around the planet and meets back up with
// itself, so it never dead-ends. Everything that needs to know where the road is (the dirt mesh here,
// the grass carve, and the movement speed) asks the same contains() check, so they always agree.
//
// How the loop is defined: pick an AXIS through the planet. Going around that axis is the angle phi
// (0..2pi). The road's centerline sits at some angle away from the axis (its "latitude", called beta),
// and that latitude WEAVES as phi goes around. Because the weave is built from whole-number sine waves,
// it lines back up after a full turn, so the loop always closes. Mixing a few sine waves of different
// sizes makes the weave uneven, so the road looks like a natural trail, not a plain circle.

// --- Placement ---
// The axis the loop wraps around. The spawn (north pole) sits at beta = pi/2 from this axis, so a
// centerline near pi/2 runs right past where the player starts.
const PATH_AXIS = new THREE.Vector3(1, 0, 0.2).normalize();
const PATH_LAT = Math.PI / 2 - 0.1; // centerline latitude (angle from the axis); a few units off the spawn

// Meander: the centerline latitude weaves by this sum of sine waves as it goes around. Different whole
// number frequencies + uneven sizes = an organic wander that still closes the loop. Amps are in radians;
// times the radius (36) is the weave in world units (so ~0.1 rad is ~3.6 units of sideways wander).
const MEANDER1_AMP = 0.12, MEANDER1_FREQ = 2.0, MEANDER1_PHASE = 0.6;
const MEANDER2_AMP = 0.06, MEANDER2_FREQ = 3.0, MEANDER2_PHASE = 2.3;
const MEANDER3_AMP = 0.035, MEANDER3_FREQ = 5.0, MEANDER3_PHASE = 4.1;

// --- Width (non-uniform + ragged edges) ---
const PATH_HALF_WIDTH = 2.75; // average half width in world units (so ~5.5 wide on average)
const WIDTH_VAR = 0.8; // broad swell/pinch of the whole road, so it narrows to ~3 and widens to ~8
const WIDTH1_FREQ = 3.0, WIDTH1_PHASE = 1.0;
const WIDTH2_FREQ = 7.0, WIDTH2_PHASE = 3.5;
// How hard each edge jags in and out on its own. This is the main "natural dirt road" dial: 0 = a clean
// even strip (concrete look), bigger = a rougher, more broken-up trail edge.
const EDGE_RAGGED = 0.45;

const PATH_SEGMENTS = 480; // how many points around the loop (more = smoother; higher now for the ragged edges)
// How many quads to lay ACROSS the road's width. The road used to be a single flat quad from edge to
// edge, but the planet is round and bulges up in the middle of that flat span. With only a tiny lift the
// near-black ground poked up through the dirt there. Splitting the width into a few steps lets the dirt
// follow the ball's curve, so the middle rides up on the sphere and stays above the ground. 4 is plenty:
// it shrinks the leftover sag by ~16x, well under PATH_LIFT.
const PATH_WIDTH_STEPS = 4;
const PATH_COLOR = 0x6b5640; // dirt brown. promote to palette once the look is settled.
// Tiny nudge outward so the dirt does not sit at the exact same radius as the ground. Coincident
// surfaces fight over pixels and flicker dark facet-shaped blobs (worst in the moving shadow). This is
// ~1/15th of a grass blade, so it still reads flush and stays well under the grass.
const PATH_LIFT = 0.06;

// Two directions across the axis, so any point can be given an angle-around (phi). ref just has to not
// line up with the axis, so the cross products are well defined.
const REF = Math.abs(PATH_AXIS.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
const AXIS_T = new THREE.Vector3().crossVectors(REF, PATH_AXIS).normalize();
const AXIS_B = new THREE.Vector3().crossVectors(PATH_AXIS, AXIS_T);

// The centerline latitude (angle from the axis) at a given angle around the loop.
function betaAt(phi) {
  return (
    PATH_LAT +
    MEANDER1_AMP * Math.sin(MEANDER1_FREQ * phi + MEANDER1_PHASE) +
    MEANDER2_AMP * Math.sin(MEANDER2_FREQ * phi + MEANDER2_PHASE) +
    MEANDER3_AMP * Math.sin(MEANDER3_FREQ * phi + MEANDER3_PHASE)
  );
}

// Gentle swell and pinch of the whole road (both edges move together), low frequency.
function swellAt(phi) {
  return 0.5 * (Math.sin(WIDTH1_FREQ * phi + WIDTH1_PHASE) + Math.sin(WIDTH2_FREQ * phi + WIDTH2_PHASE));
}

// Jagged in-and-out wander of ONE edge. Several whole-number frequencies stacked so it looks random but
// still lines up after a full loop. `side` shifts all the phases so the left and right edges never match,
// which is what stops the road looking like a clean even strip. Returns roughly -1..1.
function raggedAt(phi, side) {
  const s = side > 0 ? 0.0 : 7.3; // phase offset so the two edges differ
  return (
    0.45 * Math.sin(9 * phi + s + 0.3) +
    0.28 * Math.sin(15 * phi + s + 1.7) +
    0.19 * Math.sin(24 * phi + s + 3.1) +
    0.12 * Math.sin(38 * phi + s + 0.9)
  );
}

// Half width on one side of the centerline: base + gentle overall swell + this edge's own jagged wander.
// side is +1 for the +latitude edge, -1 for the other. Clamped so the road never pinches shut.
function edgeAt(phi, side) {
  const w = PATH_HALF_WIDTH + WIDTH_VAR * swellAt(phi) + EDGE_RAGGED * raggedAt(phi, side);
  return Math.max(w, 0.3);
}

// Unit direction on the sphere at (angle-around phi, latitude beta).
function dirAt(phi, beta, out) {
  const cp = Math.cos(phi), sp = Math.sin(phi);
  // inPlane is the direction around the axis at this phi (on the axis's equator).
  const ix = AXIS_T.x * cp + AXIS_B.x * sp;
  const iy = AXIS_T.y * cp + AXIS_B.y * sp;
  const iz = AXIS_T.z * cp + AXIS_B.z * sp;
  const cb = Math.cos(beta), sb = Math.sin(beta);
  return out.set(
    PATH_AXIS.x * cb + ix * sb,
    PATH_AXIS.y * cb + iy * sb,
    PATH_AXIS.z * cb + iz * sb,
  );
}

export function createPath(scene, planet) {
  const R = planet.radius;

  // Build the ribbon: walk around the loop, and at each step lay a whole ROW of points across the road
  // (not just the two edges), then join each step's row to the next with triangles. Every point in the
  // row is snapped onto the sphere, so the road hugs the ball's curve instead of cutting a flat chord
  // across it. It sits a hair above the surface (PATH_LIFT) so it reads as flush dirt, never a raised strip.
  const positions = [];
  const uvs = [];
  const indices = [];
  const ribbonR = R + PATH_LIFT; // radius the dirt sits at (a hair above the ground, see PATH_LIFT)
  const cols = PATH_WIDTH_STEPS + 1; // points across the road per step (steps + 1)
  const center = new THREE.Vector3();
  const side = new THREE.Vector3();
  const inPlane = new THREE.Vector3();
  const edge = new THREE.Vector3();

  for (let i = 0; i < PATH_SEGMENTS; i++) {
    const phi = (i / PATH_SEGMENTS) * Math.PI * 2;
    const beta = betaAt(phi);
    dirAt(phi, beta, center);

    // side is the surface direction across the road (along increasing latitude), so width steps run
    // straight across the road. It is the slope of the centerline as beta changes, already unit length.
    const cp = Math.cos(phi), sp = Math.sin(phi);
    inPlane.set(AXIS_T.x * cp + AXIS_B.x * sp, AXIS_T.y * cp + AXIS_B.y * sp, AXIS_T.z * cp + AXIS_B.z * sp);
    const cb = Math.cos(beta), sb = Math.sin(beta);
    side.set(
      -PATH_AXIS.x * sb + inPlane.x * cb,
      -PATH_AXIS.y * sb + inPlane.y * cb,
      -PATH_AXIS.z * sb + inPlane.z * cb,
    );

    // Each edge gets its OWN width (as an angle across the sphere), so they jag independently. angL is
    // the +side edge (at angle +angL from the centerline), angR is the -side edge (at angle -angR).
    const angL = edgeAt(phi, 1) / R;
    const angR = edgeAt(phi, -1) / R;

    // Walk across the road: for each point, rotate the centerline toward `side` by an angle that slides
    // from +angL (left edge) to -angR (right edge), then setLength back onto the ball. Because each point
    // rides the sphere, the middle of the road can't sag below the ground the way one flat span did.
    for (let w = 0; w < cols; w++) {
      const u = w / PATH_WIDTH_STEPS; // 0 at the left edge, 1 at the right edge
      const ang = angL + u * (-angR - angL); // cross angle: +angL at u=0, -angR at u=1
      edge.copy(center).multiplyScalar(Math.cos(ang)).addScaledVector(side, Math.sin(ang)).setLength(ribbonR);
      positions.push(edge.x, edge.y, edge.z);
      uvs.push(i / PATH_SEGMENTS, u);
    }
  }

  // Join the rows into triangles: connect this step's row to the next step's row, quad by quad across the
  // width, wrapping the last step back to the first to close the loop.
  for (let i = 0; i < PATH_SEGMENTS; i++) {
    const row = i * cols; // first point of this step's row
    const nextRow = ((i + 1) % PATH_SEGMENTS) * cols; // first point of the next step's row
    for (let w = 0; w < PATH_WIDTH_STEPS; w++) {
      const a = row + w; // this step, this cross point
      const b = row + w + 1; // this step, next cross point
      const c = nextRow + w; // next step, this cross point
      const d = nextRow + w + 1; // next step, next cross point
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: PATH_COLOR,
    roughness: 0.95,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);

  // Is a world point on the road (+ margin)? Turn it into (angle-around phi, latitude beta), compare its
  // latitude against the centerline's, and check that gap against the half width here. The grass carve
  // and the movement-speed check both call this, so the road they see matches the dirt mesh.
  const d = new THREE.Vector3();
  function contains(worldPos, margin = 0) {
    d.copy(worldPos).normalize();
    const beta = Math.acos(THREE.MathUtils.clamp(d.dot(PATH_AXIS), -1, 1));
    const phi = Math.atan2(d.dot(AXIS_B), d.dot(AXIS_T));
    const signed = beta - betaAt(phi); // + = one side of the centerline, - = the other
    const w = edgeAt(phi, signed >= 0 ? 1 : -1); // use that side's ragged width, so the carve matches the dirt edge
    return Math.abs(signed) * R < w + margin;
  }

  return { mesh, contains };
}
