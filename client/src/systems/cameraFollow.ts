import * as THREE from "three";
import type { Planet } from "../world/planet.js";

// Player-driven orbit camera on the planet. Yaw and pitch come from drag, not the character's
// heading, so you can orbit to see his face.
//
// A sphere has no global compass for a scalar yaw, so we persist a tangent heading vector
// `forward` and nudge it each frame: re-flatten it against the new surface normal (parallel
// transport, so the camera rolls with the planet), then rotate by the drag. Setting the camera's
// `up` to the surface normal each frame keeps the horizon level. Expose forward/right so movement
// stays camera-relative.
const ORBIT_DIST = 11; // straight-line distance from the character
const LOOK_HEIGHT = 2.4; // aim above the head so he sits low in frame, sky above
const POS_DAMP = 10; // camera position follow speed
const LOOK_SENS = 0.005; // radians per pixel of drag
const MIN_PITCH = 0.13; // ~7 deg, low but keeps the lens above the grass tops
const MAX_PITCH = 1.2; // ~69 deg, near top-down

// The character we orbit around. Only the model matters here, and it is null until the glTF loads.
type FollowTarget = { model: THREE.Object3D | null };

// Just the one input channel this reads: the drag since last frame, in pixels.
type LookInput = { consumeLook(): { x: number; y: number } };

// What createCameraFollow hands back. The player controller needs it to move camera-relative.
export type CameraFollow = ReturnType<typeof createCameraFollow>;

export function createCameraFollow( camera: THREE.Camera, target: FollowTarget, input: LookInput, planet: Planet, ) {
  let pitch = 0.32; // ~18 deg, camera sits low and looks outward so sky fills the frame
  const forward = new THREE.Vector3(0, 0, 1); // tangent heading, persisted state
  const right = new THREE.Vector3(1, 0, 0); // tangent right, derived each frame
  const up = new THREE.Vector3(0, 1, 0); // surface normal at the character
  const desired = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const yawQuat = new THREE.Quaternion();

  return {
    // Controller reads these (last frame's values) for camera-relative movement.
    getForward() {
      return forward;
    },
    getRight() {
      return right;
    },
    update(dt: number) {
      if (!target.model) return;
      const p = target.model.position;

      planet.upAt(p, up); // up = outward surface normal

      // Re-flatten the persisted heading against the new up to keep it tangent (parallel transport
      // that rolls the camera with the planet).
      forward.addScaledVector(up, -forward.dot(up));
      if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1).addScaledVector(up, -up.z); // degenerate guard
      forward.normalize();

      // Apply this frame's drag. Yaw spins around up; pitch is a clamped scalar.
      const look = input.consumeLook();
      yawQuat.setFromAxisAngle(up, -look.x * LOOK_SENS); // drag right, orbit right
      forward.applyQuaternion(yawQuat);
      pitch += look.y * LOOK_SENS; // mouse up, look up
      pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch));

      right.crossVectors(forward, up).normalize(); // screen-right (D = strafe right)

      // Offset behind the character (-forward) and above it (+up).
      const hDist = ORBIT_DIST * Math.cos(pitch);
      const vDist = ORBIT_DIST * Math.sin(pitch);
      desired
        .copy(p)
        .addScaledVector(forward, -hDist)
        .addScaledVector(up, vDist);

      const t = 1 - Math.exp(-POS_DAMP * dt); // frame-rate-independent smoothing
      camera.position.lerp(desired, t);

      camera.up.copy(up); // horizon tracks the surface normal, so up swings with the planet
      lookAt.copy(p).addScaledVector(up, LOOK_HEIGHT);
      camera.lookAt(lookAt);
    },
  };
}
