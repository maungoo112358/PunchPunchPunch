import * as THREE from "three";

// Keeps the sun (and its orthographic shadow camera, bounded to +/-10 in lights.js) centered on
// the target, so the shadow box travels with the character. Constant offset keeps the shadow
// falling in the same screen direction.
const SUN_OFFSET = new THREE.Vector3(5, 5, 4); // mid-morning angle (match lights.js + grass uSunDir)

// All this needs from the character is its model, and that is null until the glTF finishes loading.
// Note we describe the bit we use rather than importing Character: in TypeScript anything with a
// matching shape fits, so the real Character slots in here without either file knowing about the other.
// This is unlike C#, where a class only counts as an interface if it says so.
type SunTarget = { model: THREE.Object3D | null };

export function createSunFollow(sun: THREE.DirectionalLight, target: SunTarget) {
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
