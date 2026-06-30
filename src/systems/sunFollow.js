import * as THREE from "three";

// Keeps the sun (and its orthographic shadow camera, bounded to +/-10 in lights.js) centered on
// the target, so the shadow box travels with the character. Constant offset keeps the shadow
// falling in the same screen direction.
const SUN_OFFSET = new THREE.Vector3(5, 5, 4); // mid-morning angle (match lights.js + grass uSunDir)

export function createSunFollow(sun, target) {
  return {
    update() {
      if (!target.model) return;
      const p = target.model.position;
      sun.position.copy(p).add(SUN_OFFSET);
      sun.target.position.copy(p);
      sun.target.updateMatrixWorld(); // target drives the shadow camera aim
    },
  };
}
