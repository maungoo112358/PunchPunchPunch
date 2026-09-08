import * as THREE from "three";
import type { Planet } from "../world/planet.js";

// Phase 1 flight prototype (docs/Phase1.md, docs/FLIGHT_PLAN.md). Real glide physics: diving trades
// altitude for speed, climbing trades speed for altitude, there is no engine and no throttle. Drag always
// bleeds speed off, which is the entire "glide" feel.
//
// This runs on the frame's own dt, not the fixed TICK_DT that sim.ts uses, because nothing here is
// networked yet: there is no server copy of a flying plane to agree with, so there is nothing to replay.
// Once flight is networked, this needs to become a pure step(state, input, dt) function mirrored into Go,
// like sim.ts, and moved onto the fixed tick. Until then, real-time dt keeps the motion smooth with the
// least code. See FLIGHT_PLAN.md "Netcode scope".

// Every constant below is an eye-tune dial, picked to be flyable, not tuned. Expect to retune all of these
// after the owner flight-tests it.
const ALT_FLOOR = 1.5; // lowest altitude above the surface, grass clearance
const ALT_CEIL = 10; // highest altitude above the surface
const MIN_SPEED = 2; // never fully stalls in this prototype; there is no soft-fail system yet
const MAX_SPEED = 14;
const PITCH_ACCEL = 6; // speed gained per second of full dive
const DRAG = 1.5; // speed always bleeds off at this rate, whether or not you are diving
const CLIMB_RATE = 4; // altitude gained per second of full climb
const TURN_RATE = 1.4; // radians/sec of turn at full bank
const VISUAL_ROLL = 0.5; // radians of cosmetic bank tilt at full input, does not affect the turn above.
// Kept modest on purpose: a hard roll on the thin placeholder shape can present nearly edge-on to a
// camera sitting directly behind it and read as a dive rather than a turn. Revisit once the shape is real.
const VISUAL_PITCH = 0.45; // radians of cosmetic nose tilt at full input
const ORIENT_DAMP = 8; // how fast the visual tilt eases toward its target, higher = snappier

// Same shape as sim.ts's MoveInput source: x = bank (A/D or joystick x), z = dive+/climb- (W/S or
// joystick y), magnitude ignored here (unlike walking, there is no walk/run scale for flight yet).
type MoveIntent = { getDirection(): THREE.Vector3 };

type GlideState = {
  position: THREE.Vector3;
  forward: THREE.Vector3; // flat tangent direction of travel; physical, drives movement
  speed: number;
  altitude: number;
  roll: number; // current smoothed visual bank, radians, cosmetic only
  pitch: number; // current smoothed visual nose tilt, radians, cosmetic only
};

// Scratch, reused every call so a frame allocates nothing, same discipline as sim.ts.
const _up = new THREE.Vector3();
const _turn = new THREE.Quaternion();
const _right = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _pitchQuat = new THREE.Quaternion();
const _rollQuat = new THREE.Quaternion();
const _localX = new THREE.Vector3(1, 0, 0);
const _localZ = new THREE.Vector3(0, 0, 1);

export function createGlideFlight(
  plane: { model: THREE.Object3D; forward: THREE.Vector3 },
  input: MoveIntent,
  planet: Planet,
  spawn: THREE.Vector3,
  startAltitude = 3,
  startSpeed = 6,
) {
  const state: GlideState = {
    position: spawn.clone(),
    forward: plane.forward, // same object, not a copy: cameraFollow reads plane.forward directly
    speed: startSpeed,
    altitude: startAltitude,
    roll: 0,
    pitch: 0,
  };

  // Snap onto the flight band along the current up direction, the same idea as planet.placeOnSurface,
  // just with a floor/ceiling band instead of an exact radius.
  function place() {
    planet.upAt(state.position, _up);
    state.position.copy(_up).multiplyScalar(planet.radius + state.altitude).add(planet.center);
  }
  place(); // start on the band, not exactly on the ground

  return {
    get state() {
      return state;
    },
    update(dt: number) {
      const intent = input.getDirection(); // x = bank, z = dive(+)/climb(-)
      const diveInput = intent.z;
      const bankInput = intent.x;

      planet.upAt(state.position, _up);

      // Keep forward flat against the curving ground, the same trick sim.ts uses for the walking facing.
      state.forward.addScaledVector(_up, -state.forward.dot(_up));
      if (state.forward.lengthSq() < 1e-8) state.forward.set(0, 0, 1).addScaledVector(_up, -_up.z);
      state.forward.normalize();

      // Bank turns you: a continuous angular velocity around the surface normal, not a turn-toward-target
      // like the walk sim's turnToward. Sign matches cameraFollow's "drag right, orbit right" convention.
      _turn.setFromAxisAngle(_up, -bankInput * TURN_RATE * dt);
      state.forward.applyQuaternion(_turn).normalize();

      // Speed and altitude trade against each other: dive gains speed and loses height, climb the
      // reverse. Drag always bleeds speed off regardless of input, which is the entire "glide" feel.
      state.speed += diveInput * PITCH_ACCEL * dt;
      state.speed -= DRAG * dt;
      state.speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, state.speed));

      state.altitude += -diveInput * CLIMB_RATE * dt;
      state.altitude = Math.max(ALT_FLOOR, Math.min(ALT_CEIL, state.altitude));

      // Move along the flat tangent, then re-place at the new altitude.
      state.position.addScaledVector(state.forward, state.speed * dt);
      place();

      // Cosmetic tilt only, eased toward its target so it does not snap. Does not feed back into
      // forward/position above; the physical heading stays flat, this just makes it read as flying.
      const rollTarget = bankInput * VISUAL_ROLL;
      const pitchTarget = diveInput * VISUAL_PITCH;
      const t = 1 - Math.exp(-ORIENT_DAMP * dt);
      state.roll += (rollTarget - state.roll) * t;
      state.pitch += (pitchTarget - state.pitch) * t;

      // Orientation: forward -> local +Z (matches PaperPlane's nose), up -> local +Y, then bank/pitch
      // layered on top in the plane's own local frame.
      _right.crossVectors(state.forward, _up).normalize();
      _basis.makeBasis(_right, _up, state.forward);
      plane.model.quaternion.setFromRotationMatrix(_basis);
      _pitchQuat.setFromAxisAngle(_localX, state.pitch); // positive pitch input dips the nose down
      _rollQuat.setFromAxisAngle(_localZ, -state.roll); // positive bank input dips the right wing
      plane.model.quaternion.multiply(_pitchQuat).multiply(_rollQuat);

      plane.model.position.copy(state.position);
    },
  };
}

export type GlideFlight = ReturnType<typeof createGlideFlight>;