// Round-trip the wire types through both encodings and check every field comes back unchanged. The twin
// of server/wire/codec_test.go. Run with `npm run test:codec`, which compiles this with tsc and runs it
// under node, the same tsc-then-node trick the trajectory generator uses. Pure, no network.
//
// Both encodings have to be exercised: the unused path breaks quietly and you find out the day you flip
// the switch. The generic keeps each call bound to one schema, so the message types line up exactly.

import { create, equals, toJsonString } from "@bufbuild/protobuf";
import type { DescMessage, MessageShape } from "@bufbuild/protobuf";
import { encode, decode, type Encoding } from "../net/codec.js";
import { ClientMessageSchema, ServerMessageSchema } from "../net/gen/game_pb.js";

const ENCODINGS: Encoding[] = ["protobuf", "json"];

function roundTrip<Desc extends DescMessage>(name: string, schema: Desc, message: MessageShape<Desc>): number {
  let failed = 0;
  for (const encoding of ENCODINGS) {
    const frame = encode(schema, message, encoding);

    // A text frame if and only if JSON, which is the whole basis of the receiver telling them apart.
    const isText = typeof frame === "string";
    if (isText !== (encoding === "json")) {
      console.error(`FAIL ${name}/${encoding}: got a ${isText ? "text" : "binary"} frame`);
      failed++;
      continue;
    }

    const back = decode(schema, frame);
    if (equals(schema, message, back)) {
      console.log(`ok   ${name}/${encoding}`);
    } else {
      console.error(`FAIL ${name}/${encoding}: round-trip changed the message`);
      console.error(`  want ${toJsonString(schema, message)}`);
      console.error(`  got  ${toJsonString(schema, back)}`);
      failed++;
    }
  }
  return failed;
}

// One message each way, with values picked to catch trouble: a negative and a tiny fraction in a Vec3
// (double must survive, not round to float), a second planet id, and both anim strings.
const up = create(ClientMessageSchema, {
  body: { case: "input", value: { seq: 42, dir: { x: 0.1, y: -2.5, z: 3.25 } } },
});
const down = create(ServerMessageSchema, {
  body: {
    case: "snapshot",
    value: {
      tick: 7,
      ack: 41,
      players: [
        { id: "p1", planetId: 0, position: { x: 1, y: 2, z: 3 }, forward: { x: 0, y: 0, z: 1 }, anim: "Run" },
        { id: "p2", planetId: 1, position: { x: -36, y: 0.0001, z: 12.5 }, forward: { x: 1, y: 0, z: 0 }, anim: "Idle" },
      ],
    },
  },
});

const failed = roundTrip("ClientMessage", ClientMessageSchema, up) + roundTrip("ServerMessage", ServerMessageSchema, down);
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall round-trips ok");
