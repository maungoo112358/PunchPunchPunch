import * as THREE from "three";
import { writeFileSync } from "node:fs";
import { createPlayerState, stepPlayer, TICK_DT, type MoveInput } from "../systems/sim.js";
import { createPath } from "../world/path.js";
import type { Planet } from "../world/planet.js";

// Writes the golden file: a fixed list of inputs and the exact path the client's sim walks when it eats
// them. The Go test feeds the same inputs to its own copy of the sim and checks it lands on the same
// points. Change a speed, a turn rate or the road's shape in one language and forget the other, and that
// test fails immediately instead of turning up months later as players twitching for no visible reason.
//
// Run it with `npm run gen:trajectory` from client/. The output is committed, so a fresh clone can run
// the Go test without needing node at all.

// A stand-in planet: the same two bits of arithmetic as world/planet.ts, without building an 80-million
// triangle sphere we would only throw away. The real path IS used, because its meandering shape is
// exactly the sort of thing that drifts between two hand-written copies.
const RADIUS = 36;
const center = new THREE.Vector3(0, 0, 0);
const planet = {
  center,
  radius: RADIUS,
  upAt: (pos: THREE.Vector3, target: THREE.Vector3) => target.copy(pos).sub(center).normalize(),
  placeOnSurface: (pos: THREE.Vector3) => pos.sub(center).setLength(RADIUS).add(center),
} as unknown as Planet;

const path = createPath(new THREE.Scene(), planet);

// The input list. It has to exercise the things that could differ: a long run in one direction, a hard
// reverse, walking, standing still, and enough wandering to cross on and off the dirt road so both
// speeds get used.
function inputAt(i: number): THREE.Vector3 {
  if (i < 60) return new THREE.Vector3(0, 0, 1); // run straight, crosses the road
  if (i < 90) return new THREE.Vector3(0, 0, -1); // dead reverse, the turn's worst case
  if (i < 140) return new THREE.Vector3(0.5, 0, 0.2); // walk, off at an angle
  if (i < 160) return new THREE.Vector3(0, 0, 0); // stand still
  // Then a long curving run, so the facing keeps chasing a moving target.
  const a = (i - 160) * 0.05;
  return new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
}

// When the cast key goes down. Casts now run 16, 16 or 24 ticks depending on which animation the
// rotation lands on, and the next may start once 6 or fewer are left. These presses walk every branch of
// that rule, including the part where the length itself changes:
//   100          a cast from a standing start
//   105          arrives too early to use, so it must sit in the buffer and fire only when the counter
//                reaches 6. This is the whole point of the buffer.
//   200,201,202  three clicks in three ticks. The buffer is one flag, not a queue, so this must buy
//                exactly ONE extra cast, not three. Gets that wrong and spamming banks free spells.
//   300          a lone cast again, to check the buffer really did clear itself
// Five casts in all, which walks the three-clip rotation round more than once, so at least one of them
// is the long variant and its longer root is pinned by the fixture too.
// Miss any of this in one language and the two trajectories part company on the very next tick.
function attackAt(i: number): boolean {
  return i === 100 || i === 105 || i === 200 || i === 201 || i === 202 || i === 300;
}

// Where the crosshair is pointing on each tick of a cast. It has to MOVE, and it has to ask for turns
// the character cannot finish in one tick, because the whole risk in this code is the two languages
// turning at different rates or rounding the angle differently. A fixed aim would be reached in the
// first few ticks and then pin the facing, testing nothing for the remaining seventy.
//
// Sweeping it right round means every cast includes a near-reversal, which is the worst case for the
// signed-angle maths, and leaves the turn part-finished at the moment the cast ends.
function aimAt(i: number): THREE.Vector3 {
  const a = i * 0.11;
  return new THREE.Vector3(Math.cos(a), 0.35, Math.sin(a)); // the y is there so the flattening is exercised
}

const TICKS = 400;
const state = createPlayerState(new THREE.Vector3(0, RADIUS, 0));
const steps = [];
for (let i = 0; i < TICKS; i++) {
  const input: MoveInput = { seq: i, dir: inputAt(i), attack: attackAt(i), aim: aimAt(i) };
  stepPlayer(state, input, planet, path, TICK_DT);
  steps.push({
    dir: [input.dir.x, input.dir.y, input.dir.z],
    attack: input.attack,
    aim: [input.aim.x, input.aim.y, input.aim.z],
    position: [state.position.x, state.position.y, state.position.z],
    forward: [state.forward.x, state.forward.y, state.forward.z],
    anim: state.anim,
    attackLeft: state.attack,
    buffered: state.buffered,
    attackClip: state.attackClip,
  });
}

// Written out by hand rather than with JSON.stringify's indenting, which puts every single number on
// its own line and turns three hundred lines into eight thousand. Here a vector stays on one line and a
// tick is one line, so the file can be read, and a change to the walk shows up in a diff as the ticks
// that actually moved.
// Numbers go through JSON.stringify one at a time, which prints the shortest text that reads back as
// exactly the same float64. Rounding for looks would quietly loosen the very thing this file is for.
const num = (n: number) => JSON.stringify(n);
const arr = (v: number[]) => `[${v.map(num).join(", ")}]`;

// The constants go in too. If Go and TypeScript disagree about the tick length or the planet's size,
// the test says so in one line instead of leaving you to work it out from a drifting path.
const lines = [
  "{",
  `  "note": "Generated by client/src/tools/genTrajectory.ts. Do not edit by hand.",`,
  `  "tickDt": ${num(TICK_DT)},`,
  `  "radius": ${num(RADIUS)},`,
  `  "spawn": ${arr([0, RADIUS, 0])},`,
  `  "facing": ${arr([0, 0, 1])},`,
  `  "steps": [`,
  ...steps.map((s, i) => {
    const end = i === steps.length - 1 ? "" : ",";
    return (
      `    { "dir": ${arr(s.dir)}, "attack": ${s.attack}, "aim": ${arr(s.aim)}, ` +
      `"position": ${arr(s.position)}, "forward": ${arr(s.forward)}, ` +
      `"anim": ${JSON.stringify(s.anim)}, "attackLeft": ${s.attackLeft}, "buffered": ${s.buffered}, "attackClip": ${s.attackClip} }${end}`
    );
  }),
  "  ]",
  "}",
  "",
];

const out = "../server/sim/testdata/trajectory.json";
writeFileSync(out, lines.join("\n"));
console.log(`wrote ${steps.length} ticks to ${out}`);
