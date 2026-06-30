import * as THREE from "three";

// Player-driven ORBIT camera (Dark Souls / Sekiro feel), ported to the curved planet. Yaw + pitch
// come from mouse/touch DRAG — NOT the character's heading — so you can swing around to see his face.
//
// On a sphere there's no global compass to anchor a scalar yaw, so instead we persist a tangent
// heading vector `forward` and nudge it each frame: re-flatten it against the new surface normal
// (parallel transport → the camera rolls with the planet for free), then rotate by the drag. The
// camera's `up` is set to the surface normal every frame — that's what keeps the horizon level as
// you round the globe. We expose forward/right (the tangent basis) so movement stays camera-relative.
const ORBIT_DIST = 11; // straight-line distance from the character
const LOOK_HEIGHT = 1.5; // aim at the upper body, not the feet
const POS_DAMP = 10; // camera position follow speed (smooths translation only)
const LOOK_SENS = 0.005; // radians of rotation per pixel of drag
const MIN_PITCH = 0.1; // ~6°  — almost level (kept above the surface so we never flip under)
const MAX_PITCH = 1.2; // ~69° — steep, near top-down, but not straight over

export function createCameraFollow(camera, target, input, planet) {
  let pitch = 0.59; // elevation above the character (~34°, matches the old behind-the-back framing)
  const forward = new THREE.Vector3(0, 0, 1); // tangent heading (camera→character look dir); persisted state
  const right = new THREE.Vector3(1, 0, 0); // tangent right, derived each frame
  const up = new THREE.Vector3(0, 1, 0); // surface normal at the character
  const desired = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const yawQuat = new THREE.Quaternion();

  return {
    // The controller reads these (last frame's values) to build camera-relative movement.
    getForward() {
      return forward;
    },
    getRight() {
      return right;
    },
    update(dt) {
      if (!target.model) return;
      const p = target.model.position;

      planet.upAt(p, up); // local "up" = outward surface normal

      // Re-flatten the persisted heading against the new up (keeps it tangent as the character
      // moves across the curve — this is the parallel transport that rolls the camera with the planet).
      forward.addScaledVector(up, -forward.dot(up));
      if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1).addScaledVector(up, -up.z); // degenerate guard
      forward.normalize();

      // Apply this frame's drag. Yaw spins the heading around up; pitch is a clamped scalar.
      const look = input.consumeLook();
      yawQuat.setFromAxisAngle(up, -look.x * LOOK_SENS); // drag right → orbit right
      forward.applyQuaternion(yawQuat);
      pitch += look.y * LOOK_SENS; // non-inverted Y: mouse up → look up
      pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch));

      right.crossVectors(forward, up).normalize(); // screen-right when looking along +forward (D = strafe right)

      // Spherical offset BEHIND the character (along −forward) and ABOVE it (along +up).
      const hDist = ORBIT_DIST * Math.cos(pitch);
      const vDist = ORBIT_DIST * Math.sin(pitch);
      desired
        .copy(p)
        .addScaledVector(forward, -hDist)
        .addScaledVector(up, vDist);

      const t = 1 - Math.exp(-POS_DAMP * dt); // frame-rate-independent smoothing
      camera.position.lerp(desired, t);

      camera.up.copy(up); // horizon tracks the surface normal — the key to the up "swinging" with the planet
      lookAt.copy(p).addScaledVector(up, LOOK_HEIGHT);
      camera.lookAt(lookAt);
    },
  };
}
