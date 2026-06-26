import * as THREE from "three";
import { createVirtualControls } from "./virtualControls.js";

// Input is split into two source-agnostic CHANNELS so the camera + controller never care
// where the signal came from. This module is the AGGREGATOR: it fills each channel from
// every available source and hands the merged result to the rest of the game.
//   move — keyboard (WASD) OR the touch joystick. A Vector3 intent (x = strafe, z = forward).
//   look — mouse DRAG (desktop) PLUS touch drag (mobile). A per-frame (dx, dy) delta.
export function createInput() {
  // --- move source A: keyboard ---
  const keys = new Set();
  window.addEventListener("keydown", (e) => keys.add(e.code));
  window.addEventListener("keyup", (e) => keys.delete(e.code));

  // --- look source A: mouse drag (hold LEFT button, move to orbit) ---
  // Gated to pointerType "mouse" so touch never double-counts (touch look lives in
  // virtualControls). When left-click becomes "punch" later, this moves to right-drag.
  let dragging = false;
  let mouseX = 0;
  let mouseY = 0;
  window.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button === 0) dragging = true;
  });
  window.addEventListener("pointerup", (e) => {
    if (e.pointerType === "mouse") dragging = false;
  });
  window.addEventListener("pointermove", (e) => {
    if (dragging && e.pointerType === "mouse") {
      mouseX += e.movementX;
      mouseY += e.movementY;
    }
  });

  // --- sources B: the on-screen touch controls (inert on desktop) ---
  const touch = createVirtualControls();

  const intent = new THREE.Vector3(); // reused each call
  const look = { x: 0, y: 0 }; // reused each call

  return {
    // (x = strafe right+, z = forward+). Keyboard wins (normalized, full speed); if no key
    // is held, fall through to the analog joystick (magnitude preserved → analog speed).
    getDirection() {
      let x = 0;
      let z = 0;
      if (keys.has("KeyW") || keys.has("ArrowUp")) z += 1; // forward
      if (keys.has("KeyS") || keys.has("ArrowDown")) z -= 1; // back
      if (keys.has("KeyD") || keys.has("ArrowRight")) x += 1; // strafe right
      if (keys.has("KeyA") || keys.has("ArrowLeft")) x -= 1; // strafe left
      if (x !== 0 || z !== 0) {
        intent.set(x, 0, z).normalize();
        return intent;
      }
      const m = touch.getMove(); // analog: leave magnitude (≤1) intact for variable speed
      intent.set(m.x, 0, m.z);
      return intent;
    },

    // Merged drag delta (mouse + touch) since the last call, then resets. The camera reads
    // this once per frame. Returns the SAME object — read .x/.y now, don't store it.
    consumeLook() {
      const t = touch.consumeLook();
      look.x = mouseX + t.x;
      look.y = mouseY + t.y;
      mouseX = 0;
      mouseY = 0;
      return look;
    },
  };
}
