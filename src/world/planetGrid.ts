import * as THREE from "three";

// The shared reference grid we both point at when placing props. It is a COARSE icosphere (80 triangles)
// laid over the planet, totally separate from the real ground mesh. Its only job is to turn a spoken
// label like "T10" or "T10-2" into an exact spot on the planet, so when you say "put the tree at T10-2"
// the prop lands where we both expect.
//
// This file is pure math: no lines, no numbers, no scene objects, nothing that runs per frame. Props
// resolve their label to a position ONCE when they are placed, then they are just meshes. The visible
// grid (world/gridGizmo.js) is a dev-only tool built on top of this and is dropped from the release
// build, so removing it changes nothing here: gridPoint keeps returning the same spots.

const GRID_DETAIL = 1; // icosphere subdivisions. triangles = 20 * (GRID_DETAIL+1)^2, so 1 gives 80. The
// grid is only a rough anchor now (precise placement is dragging in the editor), so we keep it coarse
// with big readable numbers.
const CORNER_INSET = 0.2; // pull each corner point in this far toward the face center (0 = on the sharp
// corner, 1 = at the center). Keeps a corner label inside its own triangle so it does not sit on top of
// the neighbor triangles that share that corner, and it is where a "T10-2" prop actually lands.

// One triangle of the reference grid. All of these are unit directions from the planet center, so you
// multiply by a radius to get a real spot.
type GridFace = { center: THREE.Vector3; corners: THREE.Vector3[] };

// A resolved spot on the planet: where it is, and which way is up there.
type GridSpot = { position: THREE.Vector3; up: THREE.Vector3 };

// Put a triangle's three corners in a fixed order so "corner 1/2/3" always means the same physical point.
// Corner 1 is the one nearest the top (highest y = closest to the north pole). The other two are then
// ordered so 1 -> 2 -> 3 always wraps the same way (counter-clockwise seen from outside the planet).
function orderCorners(v0: THREE.Vector3, v1: THREE.Vector3, v2: THREE.Vector3, center: THREE.Vector3) {
  const verts = [v0, v1, v2].sort((a, b) => b.y - a.y);
  const top = verts[0];
  const rest = [verts[1], verts[2]];

  // Build a little 2D frame lying on the face: t points toward the top corner, b is 90 degrees around
  // the outward normal. Each remaining corner's angle in that frame tells us its wrap order.
  const t = top.clone().addScaledVector(center, -top.dot(center)).normalize();
  const b = new THREE.Vector3().crossVectors(center, t);
  const angle = (w: THREE.Vector3) => Math.atan2(w.dot(b), w.dot(t));
  rest.sort((a, c) => angle(a) - angle(c));

  return [top, rest[0], rest[1]];
}

export function createPlanetGrid(planetRadius: number) {
  // Build the reference shape on a unit sphere; every use scales it (planet radius for placement, a bit
  // higher for the floating dev overlay). Icosphere = evenly sized triangles, no pole pinch.
  const geo = new THREE.IcosahedronGeometry(1, GRID_DETAIL);
  const pos = geo.attributes.position; // non-indexed: face f uses verts f*3, f*3+1, f*3+2
  const faceCount = pos.count / 3;

  // faces[i] = { center, corners: [c1, c2, c3] }, all unit directions from the planet center.
  const faces: GridFace[] = [];
  for (let f = 0; f < faceCount; f++) {
    const v0 = new THREE.Vector3().fromBufferAttribute(pos, f * 3 + 0);
    const v1 = new THREE.Vector3().fromBufferAttribute(pos, f * 3 + 1);
    const v2 = new THREE.Vector3().fromBufferAttribute(pos, f * 3 + 2);
    const center = new THREE.Vector3().add(v0).add(v1).add(v2).normalize();
    const ordered = orderCorners(v0, v1, v2, center);
    const corners = ordered.map((v) =>
      v.clone().multiplyScalar(1 - CORNER_INSET).addScaledVector(center, CORNER_INSET).normalize(),
    );
    faces.push({ center, corners });
  }
  geo.dispose();

  // Turn a label into a surface spot. "T10" = the center of triangle 10; "T10-2" = corner 2 of triangle
  // 10. Faces and corners are 1-based so they read naturally. Returns { position, up } (up = the surface
  // normal, so a prop can stand straight out of the ground), or null if the label is malformed.
  function gridPoint(ref: string): GridSpot | null {
    const m = /^T(\d+)(?:-([123]))?$/i.exec(ref.trim());
    if (!m) return null;
    const face = faces[parseInt(m[1], 10) - 1];
    if (!face) return null;
    const dir = m[2] ? face.corners[parseInt(m[2], 10) - 1] : face.center;
    return { position: dir.clone().multiplyScalar(planetRadius), up: dir.clone() };
  }

  return { faces, gridPoint, detail: GRID_DETAIL, radius: planetRadius };
}
