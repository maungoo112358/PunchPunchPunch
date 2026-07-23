import { TICK_HZ } from "../systems/sim.js";
import type { Pong } from "./gen/game_pb.js";

// Lines the client clock up with the server's, from the pongs that answer our pings. Each pong carries
// the server's tick and echoes the time we sent at, so the round trip tells us how stale the tick is.
// serverNowMs() is then our best guess at the server clock right now, which is what lets remotes be drawn
// a fixed slice in the past.

// The server's tick spacing in milliseconds. Tied to the sim's tick rate so the client and server agree
// on what a tick number is worth in time.
const MS_PER_TICK = 1000 / TICK_HZ;

// How hard each new sample pulls the running offset. The first sample sets it outright; after that this
// keeps the estimate steady against the jitter in any single round trip.
const SMOOTHING = 0.1;

export function createTimeSync() {
  let offsetMs = 0; // serverNow - localNow
  let haveOffset = false;
  let rttMs = 0;

  return {
    get rttMs() {
      return rttMs;
    },
    get ready() {
      return haveOffset;
    },

    // performance.now() shifted onto the server's clock.
    serverNowMs() {
      return performance.now() + offsetMs;
    },

    onPong(pong: Pong) {
      const now = performance.now();
      rttMs = now - pong.clientTime;
      // The pong's tick was the server clock half a round trip ago, so add half the round trip to reach
      // the server clock now. The offset is that minus our own clock.
      const serverNow = pong.serverTick * MS_PER_TICK + rttMs / 2;
      const sample = serverNow - now;
      if (haveOffset) offsetMs += (sample - offsetMs) * SMOOTHING;
      else {
        offsetMs = sample;
        haveOffset = true;
      }
    },
  };
}

export type TimeSync = ReturnType<typeof createTimeSync>;
