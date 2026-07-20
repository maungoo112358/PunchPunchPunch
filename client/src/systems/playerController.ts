import * as THREE from "three";
import type { Planet } from "../world/planet.js";
import type { CameraFollow } from "./cameraFollow.js";
import { stepPlayer, type Road } from "./sim.js";
import type { WorldPlayer } from "./world.js";

// Turns what you are pushing into a world direction and steps your entry in the world state. That is
// all it does now: it does not touch the model, and it does not know a character exists. Drawing is
// the world view's job, which is what lets a networked player be drawn by the same code.
//
// Runs on the fixed tick, never on the frame's own elapsed time, because the sim has to be replayable.

// The one input channel we read. Its length is the speed, so it carries walk vs run.
type MoveInput = { getDirection(): THREE.Vector3 };

export function createPlayerController( player: WorldPlayer, input: MoveInput, cameraFollow: CameraFollow, planet: Planet, path: Road | null, ) {
  const moveDir = new THREE.Vector3(); // world tangent move direction, reused per tick

  return {
    update(dt: number) {
      const intent = input.getDirection(); // x = strafe, z = forward; magnitude = speed (0..1)
      // Resolve camera-relative intent into a world direction here, outside the sim. Your camera is
      // yours alone and the server must never need it, so what the sim (and later the server) sees is
      // already a direction on the planet. Multiplying keeps the magnitude, so walking stays a walk.
      const fwd = cameraFollow.getForward();
      const right = cameraFollow.getRight();
      moveDir.copy(fwd).multiplyScalar(intent.z).addScaledVector(right, intent.x);

      stepPlayer(player.state, { dir: moveDir }, planet, path, dt);
    },
  };
}

export type PlayerController = ReturnType<typeof createPlayerController>;
