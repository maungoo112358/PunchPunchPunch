import * as THREE from "three";
import { createPlayerState, copyPlayerState, type PlayerState } from "./sim.js";

// Everyone in the world, keyed by id. This is the layer the server will eventually write into: a
// snapshot arrives, we drop the numbers in here, and the draw pass puts them on screen without
// caring where they came from. Today there is exactly one entry, you, moved by the local controller.
//
// Each player carries two states, the current one and the one from the tick before. Rendering blends
// between them, because the sim runs at 30 ticks a second and the screen redraws faster than that.

export const LOCAL_ID = "local";

export type WorldPlayer = {
  id: string;
  state: PlayerState; // where he is now, as of the last completed tick
  previous: PlayerState; // where he was one tick earlier, the other end of the blend
};

export function createWorld() {
  const players = new Map<string, WorldPlayer>();

  return {
    players,

    add(id: string, spawn: THREE.Vector3, facing?: THREE.Vector3) {
      const player: WorldPlayer = {
        id,
        state: createPlayerState(spawn, facing),
        previous: createPlayerState(spawn, facing),
      };
      players.set(id, player);
      return player;
    },

    remove(id: string) {
      players.delete(id);
    },

    // Runs first in the fixed-tick list, before anything moves. Whatever a player's state is right
    // now becomes the "from" end of this tick's blend, and then the tick is free to overwrite it.
    update(_dt: number) {
      for (const player of players.values()) copyPlayerState(player.state, player.previous);
    },
  };
}

export type World = ReturnType<typeof createWorld>;
