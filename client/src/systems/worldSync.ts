import * as THREE from "three";
import { TICK_HZ } from "./sim.js";
import { LOCAL_ID } from "./world.js";
import type { World } from "./world.js";
import type { Planet } from "../world/planet.js";
import type { Welcome, Join, Leave, Snapshot, PlayerInfo } from "../net/gen/game_pb.js";

// Applies what the server says to the shared player map, and draws the remotes smoothly. A join adds an
// entry, a leave removes one, and snapshots feed a short buffer that each remote is drawn out of a fixed
// slice in the past, blending the two snapshots that straddle that moment. worldView draws whatever is in
// the map, so a remote appears, glides, and vanishes here with no change to the draw loop.
//
// The moment "in the past" is chosen by a local playback clock that simply trails the newest snapshot,
// not by the wall clock lined up against the server's tick timing. Those two clocks drift whenever the
// server's ticks are not perfectly even, and that drift is what made an earlier version shake: the render
// time slid up onto the newest snapshot and blending collapsed into showing each one as it landed. The
// playback clock only ever references the snapshot stream, so it cannot drift against it.
//
// Your own player is left alone. It is drawn under LOCAL_ID from local prediction, so the server's copy
// of you, named by your_id, is skipped everywhere: never added, never buffered. Bridging the two is step
// 13's job (reconciliation).

const MS_PER_TICK = 1000 / TICK_HZ;
const INTERP_DELAY_MS = 100; // how far behind the newest snapshot remotes are drawn, to ride over gaps
const BUFFER_MS = 1000; // how much snapshot history to keep
const CLOCK_CATCHUP = 0.1; // how hard the playback clock eases back toward its trailing target each frame

// One remote's pose in one snapshot, flattened out of the protobuf so the hot loop touches plain numbers.
type Pose = { x: number; y: number; z: number; fx: number; fy: number; fz: number; anim: string };
type Frame = { t: number; byId: Map<string, Pose> }; // t is server time in ms

export function createWorldSync(world: World, planet: Planet, spawn: THREE.Vector3) {
  let myId: string | null = null;
  let lastTick = 0;
  let renderClock = 0; // the playback clock, in server-time ms; trails the newest snapshot
  let clockStarted = false;
  const remotes = new Set<string>();
  const buffer: Frame[] = []; // oldest first

  // Scratch, reused every frame so the blend allocates nothing.
  const from = new THREE.Vector3();
  const to = new THREE.Vector3();
  const up = new THREE.Vector3();
  const cross = new THREE.Vector3();
  const turn = new THREE.Quaternion();

  function addRemote(info: PlayerInfo) {
    if (info.id === myId) return;
    let player = world.players.get(info.id);
    if (!player) {
      player = world.add(info.id, spawn);
      remotes.add(info.id);
    }
    player.character = info.character; // the model to wear, and the name over the head, both fixed for
    player.name = info.name; // the connection, so it is safe to just set them here on join
  }

  function removeRemote(id: string) {
    world.remove(id);
    remotes.delete(id);
  }

  return {
    get myId() {
      return myId;
    },
    get serverTick() {
      return lastTick;
    },

    onWelcome(welcome: Welcome) {
      // you is our own id, character and name; apply it to the local player, which is drawn under LOCAL_ID
      // from prediction. This is what dresses your own avatar in the character the server picked for you.
      if (welcome.you) {
        myId = welcome.you.id;
        const local = world.players.get(LOCAL_ID);
        if (local) {
          local.character = welcome.you.character;
          local.name = welcome.you.name;
        }
      }
      for (const info of welcome.players) addRemote(info);
    },

    onJoin(join: Join) {
      if (join.player) addRemote(join.player);
    },

    onLeave(leave: Leave) {
      removeRemote(leave.id);
    },

    onSnapshot(snapshot: Snapshot) {
      lastTick = snapshot.tick;
      const byId = new Map<string, Pose>();
      for (const p of snapshot.players) {
        if (p.id === myId || !p.position || !p.forward) continue;
        byId.set(p.id, {
          x: p.position.x, y: p.position.y, z: p.position.z,
          fx: p.forward.x, fy: p.forward.y, fz: p.forward.z,
          anim: p.anim,
        });
      }
      buffer.push({ t: snapshot.tick * MS_PER_TICK, byId });
      const cutoff = buffer[buffer.length - 1].t - BUFFER_MS;
      while (buffer.length > 2 && buffer[0].t < cutoff) buffer.shift();
    },

    // Per frame, not per tick: place each remote where it was INTERP_DELAY_MS behind the newest snapshot,
    // blended between the two buffered snapshots that straddle that moment. Both state and previous are
    // written to the blended pose, so worldView draws it directly without lerping on top.
    update(dt: number) {
      if (buffer.length < 2) return;

      // Advance the playback clock by real frame time, then ease it toward a target that trails the newest
      // snapshot. In steady play the target advances at the same rate, so the clock rides along locked to
      // it; a hitch in either direction is corrected over a few frames instead of snapping.
      const target = buffer[buffer.length - 1].t - INTERP_DELAY_MS;
      if (clockStarted) {
        renderClock += dt * 1000;
        renderClock += (target - renderClock) * CLOCK_CATCHUP;
      } else {
        renderClock = target;
        clockStarted = true;
      }
      const renderT = renderClock;

      // The pair straddling renderT: the last frame whose successor is at or past it.
      let i = buffer.length - 2;
      for (let k = 0; k < buffer.length - 1; k++) {
        if (buffer[k + 1].t >= renderT) {
          i = k;
          break;
        }
      }
      const a = buffer[i];
      const b = buffer[i + 1];
      const span = b.t - a.t;
      const frac = span > 0 ? THREE.MathUtils.clamp((renderT - a.t) / span, 0, 1) : 0;

      for (const id of remotes) {
        const pa = a.byId.get(id);
        const pb = b.byId.get(id);
        const player = world.players.get(id);
        if (!player || !pa || !pb) continue;

        // Position: blend the two points and snap back to the surface, the same great-circle idea the walk
        // uses, so the chord between two nearby points does not read as sinking into the planet.
        from.set(pa.x, pa.y, pa.z);
        to.set(pb.x, pb.y, pb.z);
        player.state.position.lerpVectors(from, to, frac);
        planet.placeOnSurface(player.state.position);

        // Heading: rotate from a's facing toward b's by frac of the angle between them, around the surface
        // normal, so a turning remote takes the short way instead of lerping straight through the middle.
        planet.upAt(player.state.position, up);
        from.set(pa.fx, pa.fy, pa.fz);
        to.set(pb.fx, pb.fy, pb.fz);
        cross.crossVectors(from, to);
        const angle = Math.atan2(cross.dot(up), from.dot(to));
        turn.setFromAxisAngle(up, angle * frac);
        player.state.forward.copy(from).applyQuaternion(turn).normalize();

        player.state.anim = pa.anim;

        // No second interpolation in worldView: previous mirrors state, so it draws exactly this pose.
        player.previous.position.copy(player.state.position);
        player.previous.forward.copy(player.state.forward);
        player.previous.anim = player.state.anim;
      }
    },
  };
}

export type WorldSync = ReturnType<typeof createWorldSync>;
