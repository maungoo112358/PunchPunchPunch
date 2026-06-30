// On-screen controls for touch devices: fixed bottom-center joystick (move) and look-drag
// everywhere else (look). Built only when a touch device is detected; inert on desktop so
// keyboard/mouse stay in charge. Manages its own DOM overlay (~ a Unity uGUI canvas), not the
// WebGL loop.
const RADIUS = 60; // px, joystick max travel from center
const DEADZONE = 0.18; // ignore tiny thumb wobble (below this = no move, no Run)
const ANCHOR_BOTTOM = 110; // px the stick center sits above the bottom edge
const GRAB_RADIUS = 130; // a touch within this of the stick center grabs it

export function createVirtualControls() {
  const isTouch =
    navigator.maxTouchPoints > 0 || window.matchMedia("(pointer: coarse)").matches;

  const move = { x: 0, z: 0 }; // x = strafe right+, z = forward+ (screen-up)
  const look = { x: 0, y: 0 }; // per-frame drag delta
  let lookX = 0;
  let lookY = 0;

  // Desktop: inert channels so input.js can merge unconditionally.
  if (!isTouch) {
    return {
      enabled: false,
      getMove() {
        return move;
      },
      consumeLook() {
        look.x = 0;
        look.y = 0;
        return look;
      },
    };
  }

  // full-screen touch overlay
  const root = document.createElement("div");
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    zIndex: "10",
    touchAction: "none",
  });

  // Joystick visuals, pinned bottom-center. pointerEvents:none so the root stays the single
  // touch target (stick/look touches keep e.target === root).
  const base = document.createElement("div");
  Object.assign(base.style, {
    position: "fixed",
    left: "50%",
    bottom: `${ANCHOR_BOTTOM}px`,
    width: "120px",
    height: "120px",
    transform: "translate(-50%, 50%)",
    borderRadius: "50%",
    border: "2px solid rgba(255,255,255,0.35)",
    background: "rgba(255,255,255,0.07)",
    pointerEvents: "none",
  });
  const knob = document.createElement("div");
  Object.assign(knob.style, {
    position: "fixed",
    left: "50%",
    bottom: `${ANCHOR_BOTTOM}px`,
    width: "54px",
    height: "54px",
    transform: "translate(-50%, 50%)",
    borderRadius: "50%",
    background: "rgba(255,255,255,0.30)",
    pointerEvents: "none",
  });
  root.appendChild(base);
  root.appendChild(knob);
  document.body.appendChild(root);

  // stick geometry (recomputed on demand; survives resize/rotate)
  function centerX() {
    return window.innerWidth / 2;
  }
  function centerY() {
    return window.innerHeight - ANCHOR_BOTTOM;
  }
  function setKnob(dx, dy) {
    knob.style.left = `${centerX() + dx}px`;
    knob.style.bottom = "auto";
    knob.style.top = `${centerY() + dy - 27}px`;
    knob.style.transform = "translate(-50%, 0)";
  }
  function resetKnob() {
    knob.style.left = "50%";
    knob.style.top = "auto";
    knob.style.bottom = `${ANCHOR_BOTTOM}px`;
    knob.style.transform = "translate(-50%, 50%)";
  }

  let moveId = null;
  let lookId = null;
  let lookLastX = 0;
  let lookLastY = 0;

  root.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return; // mouse handled by input.js
    const onStick =
      Math.hypot(e.clientX - centerX(), e.clientY - centerY()) < GRAB_RADIUS;
    if (onStick && moveId === null) {
      moveId = e.pointerId;
    } else if (!onStick && lookId === null) {
      lookId = e.pointerId;
      lookLastX = e.clientX;
      lookLastY = e.clientY;
    }
  });

  root.addEventListener("pointermove", (e) => {
    if (e.pointerId === moveId) {
      let dx = e.clientX - centerX();
      let dy = e.clientY - centerY();
      const dist = Math.hypot(dx, dy);
      if (dist > RADIUS) {
        dx = (dx / dist) * RADIUS;
        dy = (dy / dist) * RADIUS;
      }
      setKnob(dx, dy);
      const nx = dx / RADIUS;
      const ny = dy / RADIUS;
      if (Math.hypot(nx, ny) < DEADZONE) {
        move.x = 0;
        move.z = 0;
      } else {
        move.x = nx; // screen-right = strafe right
        move.z = -ny; // screen-up = forward
      }
    } else if (e.pointerId === lookId) {
      lookX += e.clientX - lookLastX;
      lookY += e.clientY - lookLastY;
      lookLastX = e.clientX;
      lookLastY = e.clientY;
    }
  });

  function endPointer(e) {
    if (e.pointerId === moveId) {
      moveId = null;
      move.x = 0;
      move.z = 0;
      resetKnob();
    } else if (e.pointerId === lookId) {
      lookId = null;
    }
  }
  root.addEventListener("pointerup", endPointer);
  root.addEventListener("pointercancel", endPointer);

  return {
    enabled: true,
    getMove() {
      return move;
    },
    consumeLook() {
      look.x = lookX;
      look.y = lookY;
      lookX = 0;
      lookY = 0;
      return look;
    },
  };
}
