import * as THREE from "three";
import type { World } from "./world.js";
import type { ServerHandlers } from "../net/session.js";
import type { PlayerInfo } from "../net/gen/game_pb.js";

// Applies what the server says to the shared player map. A join adds an entry, a leave removes one, and
// each snapshot moves the players it names. worldView draws whatever is in the map, so a remote character
// appears and vanishes here with no change to the draw loop.
//
// Your own player is left alone. It is drawn under LOCAL_ID from local prediction, so the server's copy
// of you, named by your_id, is skipped everywhere below: never added, never moved from a snapshot. Wiring
// your own avatar to the server is step 13's job (reconciliation). Remotes move in snapshot-sized steps
// for now; smoothing them is step 11.

export function createWorldSync(world: World, spawn: THREE.Vector3): ServerHandlers & { readonly myId: string | null; readonly serverTick: number } {
  let myId: string | null = null;
  let serverTick = 0;

  // Add a remote to the map if it is not there yet. Remotes spawn at the shared spawn point and the next
  // snapshot places them properly, which is within a frame.
  function addRemote(info: PlayerInfo) {
    if (info.id === myId) return;
    if (!world.players.has(info.id)) world.add(info.id, spawn);
  }

  return {
    get myId() {
      return myId;
    },
    get serverTick() {
      return serverTick;
    },

    onWelcome(welcome) {
      myId = welcome.yourId;
      for (const info of welcome.players) addRemote(info);
    },

    onJoin(join) {
      if (join.player) addRemote(join.player);
    },

    onLeave(leave) {
      world.remove(leave.id);
    },

    onSnapshot(snapshot) {
      serverTick = snapshot.tick;
      for (const p of snapshot.players) {
        if (p.id === myId) continue; // that is me, drawn from local prediction
        const player = world.players.get(p.id);
        if (!player || !p.position || !p.forward) continue;
        player.state.position.set(p.position.x, p.position.y, p.position.z);
        player.state.forward.set(p.forward.x, p.forward.y, p.forward.z);
        player.state.anim = p.anim;
      }
    },
  };
}

export type WorldSync = ReturnType<typeof createWorldSync>;
