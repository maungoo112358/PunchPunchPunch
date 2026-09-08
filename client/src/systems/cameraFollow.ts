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
const HEADING_DAMP = 10; // vehicle mode only: how fast the camera's heading eases toward the plane's own.
// Matches POS_DAMP on purpose. If heading snapped instantly while position eased in, the "ideal spot
// behind the plane" would sweep around at full turn speed while the camera's actual position dragged
// behind it, which reads as the camera orbiting the plane during a turn instead of chasing it smoothly.
const LOOK_SENS = 0.005; // radians per pixel of drag
const MIN_PITCH = 0.13; // ~7 deg, low but keeps the lens above the grass tops
const MAX_PITCH = 1.2; // ~69 deg, near top-down

// The character we orbit around. Only the model matters here, and it is null until the glTF loads.
// forward is optional and switches the camera into "vehicle mode" (see update() below): a plane has its
// own real heading that the camera must lock onto, unlike a walking character where the camera is free
// to orbit anywhere and movement is read relative to wherever it is currently looking.
type FollowTarget = { model: THREE.Object3D | null; forward?: THREE.Vector3 };

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
  const headingCross = new THREE.Vector3();
  const headingQuat = new THREE.Quaternion();

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

      if (target.forward) {
        // Vehicle mode. The camera's heading eases toward what it is following, like a chase camera,
        // instead of the free orbit below. A plane turns under its own control (banking), not because
        // the camera was dragged, so if the camera kept its own independent heading here the plane would
        // turn away from wherever the camera last happened to face and fly clean out of frame. Eased
        // rather than copied instantly: matching HEADING_DAMP to POS_DAMP keeps the heading and the
        // position it drives moving together, instead of heading snapping ahead of a lagging position and
        // reading as the camera orbiting the plane during a turn.
        //
        // Turn by a measured ANGLE around up, do not blend the two vectors with lerp. This is the exact
        // trap sim.ts's turnToward already documents for the walk sim: blending two nearly-opposite unit
        // vectors passes through a near-zero-length vector, and normalizing something near-zero snaps to
        // an arbitrary, numerically unstable direction — sometimes nearly straight up, which is what "the
        // plane goes perpendicular to the ground and disappears" during a turn actually was: the camera's
        // heading, not the plane's.
        const headingT = 1 - Math.exp(-HEADING_DAMP * dt);
        headingCross.crossVectors(forward, target.forward);
        const headingAngle = Math.atan2(headingCross.dot(up), forward.dot(target.forward));
        headingQuat.setFromAxisAngle(up, headingAngle * headingT);
        forward.applyQuaternion(headingQuat).normalize();

        // Horizontal look is dropped for now; vertical stays free, since tilting to look up/down does
        // not fight the plane's own heading the way spinning the camera around would.
        const look = input.consumeLook(); // still drained every frame so drag does not pile up unused
        pitch += look.y * LOOK_SENS;
        pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch));
      } else {
        // Free orbit, for a walking character. Re-flatten the persisted heading against the new up to
        // keep it tangent (parallel transport that rolls the camera with the planet).
        forward.addScaledVector(up, -forward.dot(up));
        if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1).addScaledVector(up, -up.z); // degenerate guard
        forward.normalize();

        // Apply this frame's drag. Yaw spins around up; pitch is a clamped scalar.
        const look = input.consumeLook();
        yawQuat.setFromAxisAngle(up, -look.x * LOOK_SENS); // drag right, orbit right
        forward.applyQuaternion(yawQuat);
        pitch += look.y * LOOK_SENS; // mouse up, look up
        pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch));
      }

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
