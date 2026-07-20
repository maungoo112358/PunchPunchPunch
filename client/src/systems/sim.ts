import * as THREE from "three";
import type { Planet } from "../world/planet.js";

// The movement sim: given where a player is and what they are pushing, work out where they are next.
// This is the one piece of gameplay code that has to run identically here and on the Go server, because
// the server is authoritative and reconciliation means replaying your own inputs through it and landing
// where the server says you landed. So it reads nothing global, keeps nothing of its own between calls,
// and steps by a dt we choose rather than however long the frame took. Same state plus same input plus
// same dt always gives the same answer, which is the whole reason this file exists.
// It gets mirrored line for line into Go, with a golden test holding the two copies together.

// How many times a second the sim runs. Rendering is separate and usually faster, so the draw step
// blends between the last two sim results.
export const TICK_HZ = 30;
export const TICK_DT = 1 / TICK_HZ;

// The most missed time we will ever catch up on in one frame. A browser stops handing frames to a tab
// you are not looking at, so switching away for ten seconds and back leaves us owing ten seconds of
// simulation. Without a ceiling that is 300 ticks in one frame, which either locks up or flings the
// character across the planet. Past the ceiling we drop the missed time on the floor and carry on.
export const MAX_CATCHUP = 0.25;

// Run speed depends on the ground: a touch slower slogging through grass, a touch quicker on the packed
// dirt road. Walk scales down from these by the move magnitude.
const GRASS_SPEED = 4.0; // run speed on grass (units/s)
const PATH_SPEED = 5.2; // run speed on the dirt road
const WALK_MAX = 0.6; // magnitude at or below this = Walk, above = Run
const TURN_RATE = 10; // how fast facing swings around to the travel direction, radians/s

// Everything a player is, as far as the sim and the network care. Position and facing are both world
// space; facing stays tangent to the surface. anim is the locomotion clip name the model should play.
export type PlayerState = {
  position: THREE.Vector3;
  forward: THREE.Vector3;
  anim: string;
};

// One tick of intent, already resolved to world space by whoever built it. Its length is the speed,
// so it carries walk versus run in the same three numbers.
// seq numbers the ticks, counting up forever from the moment the game starts. The sim ignores it, but
// it is what the server will echo back as "I have processed everything up to here", which is how the
// client later works out which of its own inputs still need replaying after a correction.
export type MoveInput = { seq: number; dir: THREE.Vector3 };

// The dirt road, only for asking "is he standing on it" so he can move a bit quicker.
export type Road = { contains(worldPos: THREE.Vector3, margin?: number): boolean };

// Scratch, reused so a tick allocates nothing.
const _up = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _turn = new THREE.Quaternion();

export function createPlayerState(spawn: THREE.Vector3, facing = new THREE.Vector3(0, 0, 1)): PlayerState {
  return { position: spawn.clone(), forward: facing.clone(), anim: "Idle" };
}

export function copyPlayerState(from: PlayerState, to: PlayerState) {
  to.position.copy(from.position);
  to.forward.copy(from.forward);
  to.anim = from.anim;
}

// Advance one player by one tick. Mutates state in place.
// Movement: step along the flat tangent, then snap back onto the sphere (planet.placeOnSurface).
// One tick's off-surface drift is negligible and the snap erases it (great-circle walk).
export function stepPlayer(state: PlayerState, input: MoveInput, planet: Planet, path: Road | null, dt: number) {
  const p = state.position;
  const speed = input.dir.length();

  planet.upAt(p, _up); // up = outward normal

  // Keep facing flat against the ground as the surface curves underneath. Same re-flattening the
  // camera does, and it is what lets facing be one direction on a sphere instead of a full rotation.
  state.forward.addScaledVector(_up, -state.forward.dot(_up));
  if (state.forward.lengthSq() < 1e-8) state.forward.set(0, 0, 1).addScaledVector(_up, -_up.z); // degenerate guard
  state.forward.normalize();

  if (speed > 0) {
    const runSpeed = path && path.contains(p) ? PATH_SPEED : GRASS_SPEED;
    p.addScaledVector(input.dir, runSpeed * dt);
    planet.placeOnSurface(p);
    planet.upAt(p, _up); // up changed after moving, recompute before turning

    // Swing facing toward where he is travelling, at a steady turn rate so a big turn takes longer
    // than a small one and always finishes. Used to live in Character as a visual slerp, but the
    // server owns facing now, and a turn that only happened on the client would put the two copies
    // out of step.
    // Turn by an ANGLE, do not blend the two directions. Blending slides along the straight line
    // between them, and for a dead reverse that line runs through the middle: you get a shorter
    // vector pointing the same way, which normalizes back to exactly where you started. He would
    // moonwalk forever. Rotating always turns, and a reverse gets the full rate instead of nothing.
    _dir.copy(input.dir).addScaledVector(_up, -input.dir.dot(_up)).normalize();
    // Signed angle from facing to target, measured around up. The cross product's length gives the
    // sine and its direction gives the sign, the dot gives the cosine, so atan2 of the two is the
    // angle with its side. A dead reverse lands on +pi, so he always spins the same way round.
    _cross.crossVectors(state.forward, _dir);
    const angle = Math.atan2(_cross.dot(_up), state.forward.dot(_dir));
    const step = Math.min(Math.abs(angle), TURN_RATE * dt); // never overshoot the target
    _turn.setFromAxisAngle(_up, angle < 0 ? -step : step);
    state.forward.applyQuaternion(_turn).normalize();
  }

  state.anim = speed > WALK_MAX ? "Run" : speed > 0 ? "Walk" : "Idle";
}
