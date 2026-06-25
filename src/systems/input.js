import * as THREE from "three";

// Keyboard input → a movement INTENT (not a world direction): z = forward/back,
// x = strafe right/left. The player controller rotates this by the camera yaw so
// "forward" always means "into the screen" (camera-relative third-person controls).
export function createInput() {
  const keys = new Set();
  window.addEventListener("keydown", (e) => keys.add(e.code));
  window.addEventListener("keyup", (e) => keys.delete(e.code));

  const intent = new THREE.Vector3(); // reused each call

  return {
    // (x = strafe right+, z = forward+), normalized, or zero if no key is held.
    getDirection() {
      let x = 0;
      let z = 0;
      if (keys.has("KeyW") || keys.has("ArrowUp")) z += 1; // forward
      if (keys.has("KeyS") || keys.has("ArrowDown")) z -= 1; // back
      if (keys.has("KeyD") || keys.has("ArrowRight")) x += 1; // strafe right
      if (keys.has("KeyA") || keys.has("ArrowLeft")) x -= 1; // strafe left
      intent.set(x, 0, z);
      if (intent.lengthSq() > 0) intent.normalize();
      return intent;
    },
  };
}
