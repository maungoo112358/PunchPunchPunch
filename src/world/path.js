import * as THREE from "three";
import { COLORS } from "../config/palette.js";

// A gentle winding footpath through the glade. Two jobs:
//   1) onPath(x,z) — lets the grass carve itself out where the path runs.
//   2) a thin dirt RIBBON mesh laid over the ground so the cleared strip reads as a path.
// The path is fixed world geometry (the grass field streams around it), so it stays carved.
const HALF_WIDTH = 1.1; // dirt half-width → ~2.2-unit narrow footpath
const CARVE_MARGIN = 0.4; // clear grass slightly past the dirt edge so blades don't overhang
const SAMPLES = 90; // polyline resolution along the curve

// Control points (world XZ) — a smooth S that passes near the spawn at origin.
const CONTROL = [
  [-7, -42],
  [5, -24],
  [-4, -6],
  [6, 9],
  [-3, 26],
  [4, 44],
];

export function createPath(scene) {
  const curve = new THREE.CatmullRomCurve3(
    CONTROL.map(([x, z]) => new THREE.Vector3(x, 0, z))
  );
  const pts = curve.getPoints(SAMPLES); // Vector3 polyline (y = 0)

  // Bounding box (padded) for a cheap reject before the per-segment distance test.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const pad = HALF_WIDTH + CARVE_MARGIN + 1;
  minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;

  // Shortest distance from (x,z) to the polyline (min over all segments).
  function distanceToPath(x, z) {
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x, az = pts[i].z;
      const dx = pts[i + 1].x - ax, dz = pts[i + 1].z - az;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - (ax + t * dx), ez = z - (az + t * dz);
      const d2 = ex * ex + ez * ez;
      if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
  }

  // Grass carve test: true → remove the blade here.
  function onPath(x, z) {
    if (x < minX || x > maxX || z < minZ || z > maxZ) return false; // cheap reject
    return distanceToPath(x, z) < HALF_WIDTH + CARVE_MARGIN;
  }

  // --- dirt ribbon: offset each sample point left/right along its normal, strip it ---
  const positions = [];
  const indices = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const tx = next.x - prev.x, tz = next.z - prev.z;
    const tl = Math.hypot(tx, tz) || 1;
    const nx = -tz / tl, nz = tx / tl; // XZ perpendicular
    positions.push(pts[i].x + nx * HALF_WIDTH, 0.02, pts[i].z + nz * HALF_WIDTH);
    positions.push(pts[i].x - nx * HALF_WIDTH, 0.02, pts[i].z - nz * HALF_WIDTH);
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
    indices.push(a, b, c, c, b, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: COLORS.PATH,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide, // flat ribbon — don't fuss over winding
  });
  const ribbon = new THREE.Mesh(geo, mat);
  ribbon.receiveShadow = true; // tree/character shadows fall across it
  scene.add(ribbon);

  return { onPath, distanceToPath, ribbon };
}
