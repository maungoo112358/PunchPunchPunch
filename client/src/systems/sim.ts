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

// How long a cast lasts, ONE ENTRY PER CAST ANIMATION, in ticks at 30Hz. Ticks rather than seconds so a
// cast can never land between two ticks and come out a different length on the two machines.
//
// This list is index-aligned with KAYKIT_ATTACKS in config/characters.ts, and that pairing is the whole
// design: entry 2 is longer because the clip at index 2 is the one that needed slowing down. The client
// stretches each clip to fill its own entry, so these numbers ARE the playback speeds:
//
//   0  Spellcasting        0.67s clip / 16 ticks (0.53s)  = 1.25x
//   1  Spellcast_Shoot     0.93s clip / 16 ticks (0.53s)  = 1.75x
//
// Both entries are the same here, but the list stays per variant rather than collapsing back to one
// constant, because that shape is what lets a clip be retimed on its own. With a single shared length,
// slowing any one animation slowed all of them, and a clip given less time than it needs is simply cut
// off part way through.
//
// Adding a clip means adding an entry here AND a name there, in the same position. Character.ts warns at
// load if the two lists have drifted out of step.
export const ATTACK_TICKS = [16, 16];

// How near the end of a cast the next one may start, in ticks left on the counter. The last stretch of a
// clip is the arm recovering, and nobody needs to watch that before throwing again, so a new cast may
// cut in there.
//
// The gap between chained casts is that cast's own length minus this, so the short variants chain every
// 10 ticks (a third of a second) and the long one every 18. A bigger animation costing a little fire
// rate is the honest outcome and it reads correctly.
const RECAST_WINDOW = 6;

// Everything a player is, as far as the sim and the network care. Position and facing are both world
// space; facing stays tangent to the surface. anim is the locomotion clip name the model should play.
export type PlayerState = {
  position: THREE.Vector3;
  forward: THREE.Vector3;
  anim: string;
  // Ticks of cast still to run, 0 when not casting. This is the first thing in here that is not a place
  // or a direction, and that makes it the first thing reconciliation has to rebuild rather than slide:
  // a position that is slightly wrong can ease back into line over a few frames, but "am I casting" is
  // yes or no, so a wrong guess has to be replayed away instead.
  attack: number;
  // A click that arrived too early to use, held until the cast reaches its recast window. This is what
  // makes spamming the button feel right: a press during the locked part of a cast is REMEMBERED rather
  // than thrown away, so it fires the moment it legally can instead of vanishing.
  buffered: boolean;
  // Which cast animation the current cast rolled, as an index into ATTACK_TICKS. It is sim state rather
  // than a client-side flourish for two reasons: it decides how long the cast runs, and it has to be the
  // same on every machine or you and the people watching you would see different spells.
  attackClip: number;
};

// One tick of intent, already resolved to world space by whoever built it. Its length is the speed,
// so it carries walk versus run in the same three numbers.
// seq numbers the ticks, counting up forever from the moment the game starts. The sim ignores it, but
// it is what the server will echo back as "I have processed everything up to here", which is how the
// client later works out which of its own inputs still need replaying after a correction.
// attack is true on the one tick the cast key went down, not for as long as it is held. Holding it would
// otherwise re-arm the cast every tick and the animation would never get past its first frame.
//
// aim is where the crosshair is pointing, in world space, and only its direction is read. A zero vector
// means no aim, which is what walking sends, because walking already turns you by where you are going.
export type MoveInput = { seq: number; dir: THREE.Vector3; attack: boolean; aim: THREE.Vector3 };

// The dirt road, only for asking "is he standing on it" so he can move a bit quicker.
export type Road = { contains(worldPos: THREE.Vector3, margin?: number): boolean };

// Scratch, reused so a tick allocates nothing.
const _up = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _turn = new THREE.Quaternion();

export function createPlayerState(spawn: THREE.Vector3, facing = new THREE.Vector3(0, 0, 1)): PlayerState {
  return {
    position: spawn.clone(), forward: facing.clone(), anim: "Idle",
    attack: 0, buffered: false, attackClip: 0,
  };
}

// Swing `forward` toward `target` by at most one tick's worth of turning, around the surface normal.
// Mutates forward in place. Used by both the walk, which aims at where you are travelling, and the cast,
// which aims at the crosshair, so the two can never turn at different rates.
//
// Turn by an ANGLE, do not blend the two directions. Blending slides along the straight line between
// them, and for a dead reverse that line runs through the middle: you get a shorter vector pointing the
// same way, which normalizes back to exactly where you started. He would moonwalk forever. Rotating
// always turns, and a reverse gets the full rate instead of nothing.
function turnToward(forward: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3, dt: number) {
  // Flatten the target into the ground plane first, because on a sphere a heading is only meaningful
  // once the part of it pointing at the sky is removed.
  _dir.copy(target).addScaledVector(up, -target.dot(up));
  if (_dir.lengthSq() < 1e-8) return; // aiming straight up or at nothing, no heading to turn to
  _dir.normalize();
  // Signed angle from facing to target, measured around up. The cross product's length gives the sine
  // and its direction gives the sign, the dot gives the cosine, so atan2 of the two is the angle with
  // its side. A dead reverse lands on +pi, so he always spins the same way round.
  _cross.crossVectors(forward, _dir);
  const angle = Math.atan2(_cross.dot(up), forward.dot(_dir));
  const step = Math.min(Math.abs(angle), TURN_RATE * dt); // never overshoot the target
  _turn.setFromAxisAngle(up, angle < 0 ? -step : step);
  forward.applyQuaternion(_turn).normalize();
}

export function copyPlayerState(from: PlayerState, to: PlayerState) {
  to.position.copy(from.position);
  to.forward.copy(from.forward);
  to.anim = from.anim;
  to.attack = from.attack;
  to.buffered = from.buffered;
  to.attackClip = from.attackClip;
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

  // The cast. A counter running down is the whole state machine: there is no "am I attacking" flag to
  // get out of step, just a number of ticks left.
  //
  // Three steps, in this order. Tick the counter down first, so a press this tick is measured against
  // where the cast has actually got to. Then remember any press, whether or not it can be used. Then
  // start a cast if the counter has run far enough down, which is either at zero or inside the recast
  // window near the end.
  //
  // Splitting "remember" from "start" is what gives back-to-back casting: hammering the button parks a
  // click in the buffer, and it goes off the instant the window opens rather than being dropped on the
  // floor. The buffer is a single flag, not a queue, so ten frantic clicks still only buy one extra cast
  // and the button cannot be used to bank a stream of them.
  // Which animation comes up is a straight rotation, not a random roll, and it has to be. The sim is
  // replayed: the client runs these same steps again after every correction, and a random number would
  // come out differently the second time and desync the cast length from the server's. Stepping to the
  // next one is the same answer every time, and it still guarantees no clip repeats back to back.
  if (state.attack > 0) state.attack -= 1;
  if (input.attack) state.buffered = true;
  if (state.buffered && state.attack <= RECAST_WINDOW) {
    state.attackClip = (state.attackClip + 1) % ATTACK_TICKS.length;
    state.attack = ATTACK_TICKS[state.attackClip];
    state.buffered = false;
  }

  // Casting roots you where you stand, but you still turn: the whole point of aiming is that the caster
  // ends up facing what the crosshair is on, and turning is the only way the body ever gets there. The
  // aim keeps arriving every tick of the cast, so dragging the mouse mid-cast tracks the target.
  if (state.attack > 0) {
    turnToward(state.forward, input.aim, _up, dt);
    state.anim = "Attack";
    return;
  }

  if (speed > 0) {
    const runSpeed = path && path.contains(p) ? PATH_SPEED : GRASS_SPEED;
    p.addScaledVector(input.dir, runSpeed * dt);
    planet.placeOnSurface(p);
    planet.upAt(p, _up); // up changed after moving, recompute before turning

    // Swing facing toward where he is travelling, at a steady turn rate so a big turn takes longer
    // than a small one and always finishes. Used to live in Character as a visual slerp, but the
    // server owns facing now, and a turn that only happened on the client would put the two copies
    // out of step.
    turnToward(state.forward, input.dir, _up, dt);
  }

  state.anim = speed > WALK_MAX ? "Run" : speed > 0 ? "Walk" : "Idle";
}
