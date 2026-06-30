import * as THREE from "three";
import { COLORS } from "../config/palette.js";

// The tiny spherical planet everything lives on (replaces the old flat ground plane).
// This module owns the planet's "truth" — center, radius, and the surface-normal helpers —
// and hands them to the systems that need them. The whole sphere reduces to ONE idea:
//
//     up = normalize(pos - center)
//
// With the planet at the origin that's just normalize(pos). Gravity, character orientation,
// and the follow-cam's up all derive from it (the Mario-Galaxy / Unity custom-gravity pattern:
// gravityDir = (center - playerPos).normalized). With jump/attack parked there's no falling —
// "gravity" here just means SNAP a position to the surface + orient up to the normal (kinematic).

const PLANET_RADIUS = 28; // gentle "crest of a hill" curve (Messenger-style), not a tight marble; tune to taste
const PLANET_DETAIL = 3; // icosphere subdivisions: higher = rounder silhouette, fewer visible facets

export function createPlanet(scene) {
  const center = new THREE.Vector3(0, 0, 0);

  // Icosahedron, NOT SphereGeometry: a UV-sphere pinches + packs vertices unevenly at the
  // poles (bad for scattering grass later, ugly poles). An icosphere is near-uniform and gives
  // the faceted low-poly look for free. flatShading derives per-face normals → crisp facets.
  const geometry = new THREE.IcosahedronGeometry(PLANET_RADIUS, PLANET_DETAIL);
  const material = new THREE.MeshStandardMaterial({
    color: COLORS.GROUND, // fresh grass green (same role as the old flat ground)
    flatShading: true, // low-poly faceted surface (matches the stylized art direction)
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true; // catches the character's shadow
  scene.add(mesh);

  // Surface normal (= "up") at a world position, written into `target` to avoid per-frame allocs.
  function upAt(pos, target) {
    return target.copy(pos).sub(center).normalize();
  }

  // Project a point onto the surface (push/pull it to exactly `radius` from center). Task 2's
  // controller calls this every frame after moving along the tangent, so the character never
  // drifts off the sphere.
  function placeOnSurface(pos) {
    return pos.sub(center).setLength(PLANET_RADIUS).add(center);
  }

  return { mesh, center, radius: PLANET_RADIUS, upAt, placeOnSurface };
}
