import * as THREE from "three";

// Input is split into two source-agnostic CHANNELS so the camera + controller never
// care where the signal came from (keyboard/mouse now; a mobile virtual joystick later):
//   move — a Vector3 intent (x = strafe, z = forward), made camera-relative downstream.
//   look — a per-frame mouse-DRAG delta (dx, dy) the camera turns into yaw/pitch.
export function createInput() {
  // --- move channel: keyboard ---
  const keys = new Set();
  window.addEventListener("keydown", (e) => keys.add(e.code));
  window.addEventListener("keyup", (e) => keys.delete(e.code));
  const intent = new THREE.Vector3(); // reused each call

  // --- look channel: mouse drag (hold LEFT button and move to orbit the camera) ---
  // We accumulate raw pixel deltas and hand them out once per frame via consumeLook().
  // NOTE: left button for now; when left-click becomes "punch" we'll move this to right-drag.
  let dragging = false;
  let lookX = 0;
  let lookY = 0;
  window.addEventListener("pointerdown", (e) => {
    if (e.button === 0) dragging = true; // left button grabs the camera
  });
  window.addEventListener("pointerup", () => (dragging = false));
  window.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    lookX += e.movementX; // raw pixels; the camera scales these to radians
    lookY += e.movementY;
  });
  const look = { x: 0, y: 0 }; // reused each call

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

    // The accumulated drag delta since the last call, then resets to zero. The camera
    // reads this once per frame. Returns the SAME object — read .x/.y now, don't store it.
    consumeLook() {
      look.x = lookX;
      look.y = lookY;
      lookX = 0;
      lookY = 0;
      return look;
    },
  };
}
