import * as THREE from "three";
import { createVirtualControls } from "./virtualControls.js";

// Input aggregator: fills source-agnostic CHANNELS from every device, so the rest of the
// game never sees a key or a touch. Channels:
//   move — Vector3 intent; MAGNITUDE encodes speed (keyboard: 1 = Run, Shift = Walk;
//          joystick: analog push depth). x = strafe, z = forward.
//   look — per-frame drag delta (mouse LEFT-drag + touch drag).
const WALK_SCALE = 0.5; // keyboard speed while Shift held (default Run = 1.0)

export function createInput() {
  // --- keyboard: move + Shift-walk ---
  const keys = new Set();
  window.addEventListener("keydown", (e) => keys.add(e.code));
  window.addEventListener("keyup", (e) => keys.delete(e.code));

  // --- mouse: LEFT-drag = camera look ---
  let dragging = false;
  let mouseX = 0;
  let mouseY = 0;
  window.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button === 0) dragging = true;
  });
  window.addEventListener("pointerup", (e) => {
    if (e.pointerType === "mouse" && e.button === 0) dragging = false;
  });
  window.addEventListener("pointermove", (e) => {
    if (dragging && e.pointerType === "mouse") {
      mouseX += e.movementX;
      mouseY += e.movementY;
    }
  });

  // --- touch controls (joystick + look; inert on desktop) ---
  const touch = createVirtualControls();

  const intent = new THREE.Vector3(); // reused
  const look = { x: 0, y: 0 }; // reused

  return {
    // Magnitude-encoded move. Keyboard wins (Run, or Walk while Shift); else the analog stick.
    getDirection() {
      let x = 0;
      let z = 0;
      if (keys.has("KeyW") || keys.has("ArrowUp")) z += 1;
      if (keys.has("KeyS") || keys.has("ArrowDown")) z -= 1;
      if (keys.has("KeyD") || keys.has("ArrowRight")) x += 1;
      if (keys.has("KeyA") || keys.has("ArrowLeft")) x -= 1;
      if (x !== 0 || z !== 0) {
        const scale =
          keys.has("ShiftLeft") || keys.has("ShiftRight") ? WALK_SCALE : 1;
        intent.set(x, 0, z).normalize().multiplyScalar(scale);
        return intent;
      }
      const m = touch.getMove(); // analog (≤1): push depth → Walk/Run
      intent.set(m.x, 0, m.z);
      return intent;
    },

    // Merged drag delta (mouse + touch), then resets. Camera reads once per frame.
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
