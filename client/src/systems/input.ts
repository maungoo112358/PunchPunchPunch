import * as THREE from "three";
import { createVirtualControls } from "./virtualControls.js";

// Input aggregator: fills source-agnostic channels from every device, so the rest of the game
// never sees a key or a touch. Channels:
//   move: Vector3 intent; magnitude = speed (keyboard 1 = Run, Shift = Walk; joystick push
//         depth). x = strafe, z = forward.
//   look: per-frame drag delta (mouse RIGHT-drag + touch drag).
//   attack: a single left click, latched until something reads it.
const WALK_SCALE = 0.5; // keyboard speed while Shift held (default Run = 1.0)

export function createInput() {
  // keyboard: move + Shift-walk
  const keys = new Set();
  window.addEventListener("keydown", (e) => keys.add(e.code));
  window.addEventListener("keyup", (e) => keys.delete(e.code));

  // mouse: LEFT = cast the wand, RIGHT-drag = camera look. Left used to be the camera; it moved so a
  // click can mean one thing only, with no guessing about whether a small movement was a drag or a shot.
  let dragging = false;
  let mouseX = 0;
  let mouseY = 0;

  // The cast is an edge, not a state. Move is a "what are you holding right now" question asked fresh
  // every tick, but a cast happens once at the moment the button goes down, and the tick that asks may be
  // a few milliseconds later, so the click has to wait somewhere until someone comes for it. That is all
  // this flag is: a click parked here until consumeAttack takes it.
  let attackPressed = false;

  window.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse") return;
    if (e.button === 0) attackPressed = true; // left: cast
    if (e.button === 2) dragging = true; // right: orbit
  });
  window.addEventListener("pointerup", (e) => {
    if (e.pointerType === "mouse" && e.button === 2) dragging = false;
  });
  // Where the cursor is, as normalized device coordinates: -1 to 1 across the screen and -1 to 1 up it,
  // with 0,0 dead centre. That is the shape a camera raycast wants, and converting here means the aiming
  // code never has to know the window size. Y is flipped because the browser counts pixels DOWN from the
  // top while the graphics convention counts UP from the middle.
  //
  // Tracked whether or not a button is held, because the cursor is the crosshair: it aims all the time,
  // not only while clicking.
  const pointer = { x: 0, y: 0 };

  // The same spot in plain screen pixels, which is what the crosshair drawn on top of the game needs.
  // Kept alongside rather than converted back, because going pixels to NDC and back loses nothing but
  // costs a division in both directions on every mouse move.
  const pointerPx = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  window.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    pointerPx.x = e.clientX;
    pointerPx.y = e.clientY;
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    if (dragging) {
      mouseX += e.movementX;
      mouseY += e.movementY;
    }
  });
  // Right-dragging the camera would otherwise drop the browser's context menu over the game on every
  // turn, and releasing outside the window would leave the camera stuck mid-drag.
  window.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("blur", () => {
    dragging = false;
    keys.clear();
  });

  // touch controls (joystick + look; inert on desktop)
  const touch = createVirtualControls();

  const intent = new THREE.Vector3(); // reused
  const look = { x: 0, y: 0 }; // reused

  return {
    // Magnitude-encoded move. Keyboard wins (Run, or Walk while Shift), else the analog stick.
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
      const m = touch.getMove(); // analog (<=1): push depth = Walk/Run
      intent.set(m.x, 0, m.z);
      return intent;
    },

    // Where the crosshair is pointing, in normalized device coordinates. Handed back as the live object
    // rather than a copy, because the only reader is the aiming code once a frame.
    getPointer() {
      return pointer;
    },

    // The cursor in screen pixels, for the crosshair drawn over the game.
    getPointerPx() {
      return pointerPx;
    },

    // Hand over a waiting cast press and clear it, so one press produces exactly one cast. The controller
    // calls this once a tick, which is why it takes rather than peeks: leaving it set would fire again on
    // the next tick and every tick after.
    consumeAttack() {
      const pressed = attackPressed;
      attackPressed = false;
      return pressed;
    },

    // Merged drag delta (mouse + touch), then reset. Camera reads once per frame.
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
