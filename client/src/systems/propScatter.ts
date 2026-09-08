import * as THREE from "three";
import type { PropEntry } from "./props.js";
import type { PropName } from "../config/propCatalog.js";

// A quick scatter of props across the planet, purely so there is something to judge motion against while
// flight-testing (docs/Phase1.md) — a flat grass field gives no visual cue that you are actually moving.
// This is NOT the real "dress the planet with props" content pass (CLAUDE.md, "Actually pending"); that
// one is hand-placed through the M-key editor into propPlacements.yaml and is the owner's call on where
// things go. This is a stopgap landmark field, kept separate so it is easy to delete once the real pass
// exists, or once it has served its purpose as a motion reference.

const COUNT = 120; // modest on purpose: each prop is its own draw call (GRAPHICS_PIPELINE ch.11)
const SEED = 20260908; // fixed, so the scatter is identical on every reload instead of reshuffling
const SPAWN_CLEAR_COS = 0.95; // ~18 degrees around the launch spot kept clear (dot product threshold)

// A mix that reads well both close to the ground and from altitude: trees give you something to judge
// distance and height against while flying; rocks and bushes read better near the ground.
const MODELS: PropName[] = [
  "tree_1", "tree_2", "tree_3", "tree_4", "tree_5",
  "pine_1", "pine_2", "pine_3",
  "twisted_1", "twisted_2",
  "rock_1", "rock_2", "rock_3",
  "bush", "bush_flowers",
  "mushroom_1", "mushroom_2",
];

// A small deterministic RNG (mulberry32). Math.random() would reshuffle the scatter on every reload,
// which defeats the point of a stable field you can learn to judge motion against.
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function scatterRandomProps(spawnUp = new THREE.Vector3(0, 1, 0)): PropEntry[] {
  const rand = mulberry32(SEED);
  const entries: PropEntry[] = [];
  const dir = new THREE.Vector3();
  while (entries.length < COUNT) {
    // Uniform point on a unit sphere (Archimedes' projection): pick y uniformly in [-1,1] and go around
    // at that latitude, rather than picking two random angles, which bunches points up at the poles.
    const y = rand() * 2 - 1;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = rand() * Math.PI * 2;
    dir.set(r * Math.cos(theta), y, r * Math.sin(theta));
    if (dir.dot(spawnUp) > SPAWN_CLEAR_COS) continue; // keep the launch spot clear

    const model = MODELS[Math.floor(rand() * MODELS.length)];
    entries.push({
      model,
      dir: [dir.x, dir.y, dir.z],
      yawDegrees: Math.floor(rand() * 360),
      scale: 0.8 + rand() * 0.6, // a little size variety so it does not look copy-pasted
    });
  }
  return entries;
}
