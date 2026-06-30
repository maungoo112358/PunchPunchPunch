import * as THREE from "three";
import { COLORS } from "../config/palette.js";

// The tiny spherical planet everything lives on. Owns center, radius, and the
// surface-normal helpers. Core idea: up = normalize(pos - center), which is just
// normalize(pos) with the planet at the origin. No falling (jump/attack parked):
// "gravity" just snaps a position to the surface and orients up to the normal.

const PLANET_RADIUS = 36; // bigger = gentler curve, larger-reading world
const PLANET_DETAIL = 11; // icosphere subdivisions: higher = rounder, fewer facets

export function createPlanet(scene) {
  const center = new THREE.Vector3(0, 0, 0);

  // Use an icosphere, not a UV-sphere: even vertex spread, no pole pinch, flat-shaded facets for free.
  const geometry = new THREE.IcosahedronGeometry(PLANET_RADIUS, PLANET_DETAIL);
  const material = new THREE.MeshStandardMaterial({
    color: COLORS.GROUND, // grass green
    flatShading: true, // low-poly faceted surface
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true; // catches the character's shadow
  scene.add(mesh);

  // Surface normal (up) at a world position, written into target to avoid per-frame allocs.
  function upAt(pos, target) {
    return target.copy(pos).sub(center).normalize();
  }

  // Snap a point to exactly radius from center. Controller calls this each frame after
  // moving along the tangent so the character never drifts off the sphere.
  function placeOnSurface(pos) {
    return pos.sub(center).setLength(PLANET_RADIUS).add(center);
  }

  return { mesh, center, radius: PLANET_RADIUS, upAt, placeOnSurface };
}
