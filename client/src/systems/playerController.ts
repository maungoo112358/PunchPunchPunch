import * as THREE from "three";
import type { Planet } from "../world/planet.js";
import type { CameraFollow } from "./cameraFollow.js";
import { stepPlayer, type MoveInput, type Road } from "./sim.js";
import type { WorldPlayer } from "./world.js";

// Turns what you are pushing into a world direction and steps your entry in the world state. That is
// all it does now: it does not touch the model, and it does not know a character exists. Drawing is
// the world view's job, which is what lets a networked player be drawn by the same code.
//
// Runs on the fixed tick, never on the frame's own elapsed time, because the sim has to be replayable.

// The one input channel we read. Its length is the speed, so it carries walk vs run.
type IntentSource = { getDirection(): THREE.Vector3 };

// How many recent inputs we keep. Nothing acknowledges them yet, so the oldest is simply dropped once
// the list is full. Three seconds is far more than any round trip, and at step 13 the drop rule becomes
// "throw away everything the server has confirmed" instead of "throw away the oldest".
const MAX_PENDING = 90; // 3 seconds at 30 ticks

export function createPlayerController( player: WorldPlayer, input: IntentSource, cameraFollow: CameraFollow, planet: Planet, path: Road | null, ) {
  const pending: MoveInput[] = []; // inputs we have applied, newest last, waiting to be confirmed
  let nextSeq = 0;

  return {
    pending,

    update(dt: number) {
      const intent = input.getDirection(); // x = strafe, z = forward; magnitude = speed (0..1)
      // Resolve camera-relative intent into a world direction here, outside the sim. Your camera is
      // yours alone and the server must never need it, so what the sim (and later the server) sees is
      // already a direction on the planet. Multiplying keeps the magnitude, so walking stays a walk.
      const fwd = cameraFollow.getForward();
      const right = cameraFollow.getRight();
      const dir = new THREE.Vector3().copy(fwd).multiplyScalar(intent.z).addScaledVector(right, intent.x);

      // A fresh record every tick, not a reused one. This is the thing that goes on the wire and the
      // thing we replay from, so it has to still hold this tick's numbers long after the tick is over.
      const record: MoveInput = { seq: nextSeq++, dir };
      pending.push(record);
      if (pending.length > MAX_PENDING) pending.shift();

      stepPlayer(player.state, record, planet, path, dt);
    },
  };
}

export type PlayerController = ReturnType<typeof createPlayerController>;
