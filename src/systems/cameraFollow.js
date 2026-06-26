import * as THREE from "three";

// Player-driven ORBIT camera (Dark Souls / Sekiro feel). Yaw + pitch come from mouse
// DRAG (the look channel) — NOT from the character's heading — so you can swing around
// and finally see his face. It still exposes its yaw so movement stays camera-relative.
const ORBIT_DIST = 11; // straight-line distance from the character
const LOOK_HEIGHT = 1.5; // aim at the upper body, not the feet
const POS_DAMP = 10; // camera position follow speed (smooths translation only)
const LOOK_SENS = 0.005; // radians of rotation per pixel of drag
const MIN_PITCH = 0.1; // ~6°  — almost level (kept above ground so we never flip under)
const MAX_PITCH = 1.2; // ~69° — steep, near top-down, but not straight over

export function createCameraFollow(camera, target, input) {
  let yaw = 0; // camera heading (radians) — what the player aims with the mouse
  let pitch = 0.59; // elevation above the character (~34°, matches the old behind-the-back framing)
  const desired = new THREE.Vector3();
  const lookAt = new THREE.Vector3();

  return {
    getYaw() {
      return yaw;
    },
    update(dt) {
      if (!target.model) return;
      const p = target.model.position;

      // Apply this frame's drag to the orbit angles. Drag right → orbit right; drag down
      // → look down. (Flip a sign here if either axis feels inverted to you.)
      const look = input.consumeLook();
      yaw -= look.x * LOOK_SENS;
      pitch += look.y * LOOK_SENS; // non-inverted Y: mouse up → look up
      pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch)); // clamp so it can't flip over/under

      // Spherical offset behind the character: higher pitch = camera higher + pulled in.
      const hDist = ORBIT_DIST * Math.cos(pitch); // horizontal distance behind
      const vDist = ORBIT_DIST * Math.sin(pitch); // height above
      desired.set(
        p.x - Math.sin(yaw) * hDist,
        p.y + vDist,
        p.z - Math.cos(yaw) * hDist
      );

      const t = 1 - Math.exp(-POS_DAMP * dt); // frame-rate-independent smoothing
      camera.position.lerp(desired, t);

      lookAt.set(p.x, p.y + LOOK_HEIGHT, p.z);
      camera.lookAt(lookAt);
    },
  };
}
