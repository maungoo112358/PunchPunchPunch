import * as THREE from "three";
import type { Planet } from "../world/planet.js";
import type { CameraFollow } from "./cameraFollow.js";
import { stepPlayer, createPlayerState, TICK_DT, type MoveInput, type Road } from "./sim.js";
import type { WorldPlayer } from "./world.js";
import type { SelfCorrection } from "./worldSync.js";

// Moves your own player, and keeps it honest against the server. Every tick it turns what you are pushing
// into a world direction, applies it to a local prediction right away so the avatar answers your keys with
// no delay, and sends the same input up. When a snapshot comes back saying "I processed up to input N and
// you were here", it drops the inputs the server has confirmed, resets to the server's position, and
// replays the rest through the same stepPlayer to land back at now. That is reconciliation: the server is
// the authority, the prediction runs ahead of it and is nudged back into line.
//
// The prediction is the controller's own authoritative state. What the rest of the game draws, player.state,
// is that plus a small error that decays over a few frames, so a correction eases in instead of snapping.
// A correction too big to slide over just snaps. Because the Go and TS sims are identical and we replay our
// own inputs, corrections are normally near zero; the visible win is that movement is instant, not lagged.
//
// Runs on the fixed tick, never on the frame's own elapsed time, because the sim has to be replayable.

type IntentSource = { getDirection(): THREE.Vector3 };
type SendInput = (input: MoveInput) => void;
type GetCorrection = () => SelfCorrection | null;

// How many recent inputs we keep. Trimmed from the front as the server confirms them, so it rarely grows
// near this; the cap is a backstop against a server that goes quiet. 3 seconds at 30 ticks.
const MAX_PENDING = 90;

// How much of the smoothing error is shed each tick, and the distance past which we stop sliding and snap.
const SMOOTH_DECAY = 0.85;
const SNAP_DISTANCE = 3;

export function createPlayerController(
  player: WorldPlayer,
  input: IntentSource,
  cameraFollow: CameraFollow,
  planet: Planet,
  path: Road | null,
  send?: SendInput,
  getCorrection?: GetCorrection,
) {
  const pending: MoveInput[] = []; // inputs applied and sent, newest last, waiting for the server to confirm
  let nextSeq = 0;

  // The authoritative local prediction. player.state is the rendered result: this plus the decaying error.
  const predicted = createPlayerState(player.state.position, player.state.forward);
  const renderError = new THREE.Vector3(); // rendered = predicted + this, easing back to zero
  let enabled = true;
  let lastReconciledTick = -1;

  const before = new THREE.Vector3(); // scratch, where we were predicting before a reconcile

  function reconcile(c: SelfCorrection) {
    // Everything up to ack is confirmed and no longer needs replaying.
    while (pending.length > 0 && pending[0].seq <= c.ack) pending.shift();

    before.copy(predicted.position);

    // Snap the prediction to the server's truth, then rebuild "now" from the inputs it has not seen yet.
    predicted.position.set(c.x, c.y, c.z);
    predicted.forward.set(c.fx, c.fy, c.fz);
    predicted.anim = c.anim;
    for (const inp of pending) stepPlayer(predicted, inp, planet, path, TICK_DT);

    // Fold the jump into the error so the drawn position does not move this frame; it eases over the next.
    renderError.add(before).sub(predicted.position);
    if (renderError.length() > SNAP_DISTANCE) renderError.set(0, 0, 0); // too far to slide, just snap
  }

  return {
    pending,
    get enabled() {
      return enabled;
    },
    togglePrediction() {
      enabled = !enabled;
      renderError.set(0, 0, 0);
      if (!enabled) pending.length = 0; // not replaying while off, so do not hold a stale list
      console.log(`[predict] ${enabled ? "on" : "off"}`);
    },

    update(dt: number) {
      // Reconcile against the newest server word, once, when it is newer than what we last folded in.
      const c = getCorrection?.();
      if (c && c.tick > lastReconciledTick) {
        lastReconciledTick = c.tick;
        if (enabled) {
          reconcile(c);
        } else {
          // Prediction off: just wear the server's position, which lags by a round trip. This toggle is
          // what makes the difference visible, keys against picture.
          predicted.position.set(c.x, c.y, c.z);
          predicted.forward.set(c.fx, c.fy, c.fz);
          predicted.anim = c.anim;
        }
      }

      // Build this tick's input from camera-relative intent, and send it up whether or not we predict.
      const intent = input.getDirection(); // x = strafe, z = forward; magnitude = speed (0..1)
      const fwd = cameraFollow.getForward();
      const right = cameraFollow.getRight();
      const dir = new THREE.Vector3().copy(fwd).multiplyScalar(intent.z).addScaledVector(right, intent.x);
      const record: MoveInput = { seq: nextSeq++, dir };
      send?.(record);

      if (enabled) {
        pending.push(record);
        if (pending.length > MAX_PENDING) pending.shift();
        stepPlayer(predicted, record, planet, path, dt);
        renderError.multiplyScalar(SMOOTH_DECAY);
      }

      // The rendered state the camera, the grass parting and the draw pass all read.
      player.state.position.copy(predicted.position).add(renderError);
      player.state.forward.copy(predicted.forward);
      player.state.anim = predicted.anim;
    },
  };
}

export type PlayerController = ReturnType<typeof createPlayerController>;
