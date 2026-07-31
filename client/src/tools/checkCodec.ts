// Round-trip the wire types through both encodings and check every field comes back unchanged. The twin
// of server/wire/codec_test.go. Run with `npm run test:codec`, which compiles this with tsc and runs it
// under node, the same tsc-then-node trick the trajectory generator uses. Pure, no network.
//
// Both encodings have to be exercised: the unused path breaks quietly and you find out the day you flip
// the switch. The generic keeps each call bound to one schema, so the message types line up exactly.

import { create, equals, toJsonString } from "@bufbuild/protobuf";
import type { DescMessage, MessageShape } from "@bufbuild/protobuf";
import { encode, decode, type Encoding } from "../net/codec.js";
import { ClientMessageSchema, ServerMessageSchema, VoiceSignal_Kind } from "../net/gen/game_pb.js";

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
  body: {
    case: "input",
    value: {
      seq: 42,
      dir: { x: 0.1, y: -2.5, z: 3.25 },
      attack: true,
      aim: { x: -0.75, y: 0.125, z: 8.5 },
    },
  },
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
        // Mid-cast, so the attack counter is a non-zero number rather than the default protobuf leaves off
        // the wire entirely. A field only ever sent as zero is a field neither encoding is really testing.
        { id: "p3", planetId: 0, position: { x: 0, y: 36, z: 0 }, forward: { x: 0, y: 0, z: 1 }, anim: "Attack", attack: 17, attackBuffered: true, attackClip: 2 },
      ],
    },
  },
});

// A voice handshake each way. The payload is deliberately awkward: a real audio description is many lines
// separated by carriage-return-newline pairs, and those have to survive JSON escaping exactly or the far
// browser is handed something it cannot read. The enum matters too, because JSON writes it as a name and
// protobuf as a number, so it is the one field where the two encodings look least alike.
const voiceUp = create(ClientMessageSchema, {
  body: {
    case: "voice",
    value: {
      peer: "p2",
      kind: VoiceSignal_Kind.OFFER,
      payload: "v=0\r\no=- 46117 2 IN IP4 127.0.0.1\r\ns=-\r\na=group:BUNDLE 0\r\n",
    },
  },
});
const voiceDown = create(ServerMessageSchema, {
  body: {
    case: "voice",
    value: {
      peer: "p1",
      kind: VoiceSignal_Kind.CANDIDATE,
      payload: `{"candidate":"candidate:1 1 udp 2113937151 192.168.0.5 54321 typ host","sdpMid":"0"}`,
    },
  },
});

const failed =
  roundTrip("ClientMessage", ClientMessageSchema, up) +
  roundTrip("ServerMessage", ServerMessageSchema, down) +
  roundTrip("ClientMessage/voice", ClientMessageSchema, voiceUp) +
  roundTrip("ServerMessage/voice", ServerMessageSchema, voiceDown);
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall round-trips ok");
