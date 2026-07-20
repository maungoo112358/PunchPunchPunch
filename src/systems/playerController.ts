import * as THREE from "three";
import type { Planet } from "../world/planet.js";
import type { CameraFollow } from "./cameraFollow.js";
import { createPlayerState, copyPlayerState, stepPlayer, type PlayerState, type Road } from "./sim.js";

// Drives the local player. Two jobs, deliberately split, because they run on different clocks:
//   update(dt)     turns what you are pushing into a world direction and steps the sim. Fixed tick.
//   render(alpha)  blends the last two sim results onto the model. Every drawn frame.
// The split is what makes the movement replayable. The sim only ever sees a fixed dt, and the wobble
// of real frame times is absorbed by the blend instead of leaking into the simulation.

// The three things we do to the character: read where it is, turn it, and pick its animation.
type Player = {
  model: THREE.Object3D | null;
  orient(up: THREE.Vector3, forward: THREE.Vector3): void;
  setAction(name: string, fade?: number): void;
};

// The one input channel we read. Its length is the speed, so it carries walk vs run.
type MoveInput = { getDirection(): THREE.Vector3 };

export function createPlayerController( character: Player, input: MoveInput, cameraFollow: CameraFollow, planet: Planet, path: Road | null, spawn: THREE.Vector3, ) {
  const state = createPlayerState(spawn);
  const previous = createPlayerState(spawn); // where he was one tick ago, the other end of the blend
  const moveDir = new THREE.Vector3(); // world tangent move direction, reused per tick
  const up = new THREE.Vector3(); // surface normal under the drawn position, reused per frame
  const drawPos = new THREE.Vector3();
  const drawFwd = new THREE.Vector3();

  return {
    state,

    update(dt: number) {
      copyPlayerState(state, previous); // this tick's start is the blend's "from"

      const intent = input.getDirection(); // x = strafe, z = forward; magnitude = speed (0..1)
      // Resolve camera-relative intent into a world direction here, outside the sim. Your camera is
      // yours alone and the server must never need it, so what the sim (and later the server) sees is
      // already a direction on the planet. Multiplying keeps the magnitude, so walking stays a walk.
      const fwd = cameraFollow.getForward();
      const right = cameraFollow.getRight();
      moveDir.copy(fwd).multiplyScalar(intent.z).addScaledVector(right, intent.x);

      stepPlayer(state, { dir: moveDir }, planet, path, dt);
    },

    // alpha is how far we are between the previous tick and the current one, 0 to 1. At 30 ticks a
    // second and 120 frames a second this is what stops the character stepping four times per move.
    render(alpha: number) {
      if (!character.model) return;
      drawPos.lerpVectors(previous.position, state.position, alpha);
      drawFwd.lerpVectors(previous.forward, state.forward, alpha);
      if (drawFwd.lengthSq() < 1e-8) drawFwd.copy(state.forward); // opposite facings cancelled out

      character.model.position.copy(drawPos);
      planet.upAt(drawPos, up);
      character.orient(up, drawFwd);
      character.setAction(state.anim);
    },
  };
}

export type PlayerController = ReturnType<typeof createPlayerController>;
export type { PlayerState };
