import * as THREE from "three";

// Keyboard input → a normalized world-XZ direction. Screen-relative: because the
// PoE2 camera never rotates, "up on screen" is always -Z. Knows nothing about the
// character — pure input. (Unity analog: building our own Input axis from key state.)
export function createInput() {
  const keys = new Set();
  window.addEventListener("keydown", (e) => keys.add(e.code));
  window.addEventListener("keyup", (e) => keys.delete(e.code));

  const dir = new THREE.Vector3(); // reused each call (don't hold the reference)

  return {
    // Normalized (x,0,z) direction, or a zero vector when no movement key is held.
    getDirection() {
      let x = 0;
      let z = 0;
      if (keys.has("KeyW") || keys.has("ArrowUp")) z -= 1; // toward top of screen
      if (keys.has("KeyS") || keys.has("ArrowDown")) z += 1;
      if (keys.has("KeyA") || keys.has("ArrowLeft")) x -= 1;
      if (keys.has("KeyD") || keys.has("ArrowRight")) x += 1;
      dir.set(x, 0, z);
      if (dir.lengthSq() > 0) dir.normalize(); // so diagonals aren't faster
      return dir;
    },
  };
}
