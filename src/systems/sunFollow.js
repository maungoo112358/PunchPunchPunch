import * as THREE from "three";

// Keeps the sun (and therefore its ORTHOGRAPHIC shadow camera, bounded to ±10 in
// lights.js) centered on the target, so the shadow box travels with the character
// instead of being left behind once he walks past the origin. The offset is constant,
// so the shadow always falls in the same screen direction.
const SUN_OFFSET = new THREE.Vector3(3, 4, 5); // same relative direction as the static sun

export function createSunFollow(sun, target) {
  return {
    update() {
      if (!target.model) return;
      const p = target.model.position;
      sun.position.copy(p).add(SUN_OFFSET);
      sun.target.position.copy(p);
      sun.target.updateMatrixWorld(); // target drives the shadow camera's aim
    },
  };
}
