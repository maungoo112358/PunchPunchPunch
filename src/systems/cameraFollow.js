import * as THREE from "three";

// PoE2 fixed-angle follow: the camera keeps a CONSTANT offset from the target (the
// offset vector IS the angle), never rotates, and smoothly trails with damping.
const OFFSET = new THREE.Vector3(0, 10, 7); // ~55° pitch: atan(10/7). Higher Y = more top-down.
const DAMPING = 6; // higher = snappier follow, lower = floatier trailing
const LOOK_HEIGHT = 1; // aim at torso height, not the feet

export function createCameraFollow(camera, target) {
  const desired = new THREE.Vector3();
  const lookAt = new THREE.Vector3();

  return {
    update(dt) {
      if (!target.model) return;
      const p = target.model.position;

      // Frame-rate-independent smoothing toward the desired (offset) position.
      desired.copy(p).add(OFFSET);
      const t = 1 - Math.exp(-DAMPING * dt);
      camera.position.lerp(desired, t);

      lookAt.copy(p);
      lookAt.y += LOOK_HEIGHT;
      camera.lookAt(lookAt);
    },
  };
}
