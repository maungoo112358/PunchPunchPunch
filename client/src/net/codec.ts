import { toBinary, fromBinary, toJson, toJsonString, fromJsonString } from "@bufbuild/protobuf";
import type { DescMessage, MessageShape } from "@bufbuild/protobuf";

// The codec seam: the one place a message turns into bytes and back. Everything that crosses the socket
// goes through here, so the tick loop never touches protobuf or JSON directly. The message shapes come
// from net/gen, generated from proto/game.proto, so this file only worries about encoding, not fields.
//
// One schema, two encodings. The trick is the receiver never reads a flag: a WebSocket text frame is
// JSON, a binary frame is protobuf, and the frame type already carries the answer. Only the sender
// consults its choice, which is why encode takes an Encoding and decode does not.

// How a connection wants its outbound frames serialized. Set once per connection next step, from the
// socket URL. JSON is readable, protobuf is smaller, and the plan is to measure the gap, not argue it.
export type Encoding = "protobuf" | "json";

// Exactly what a WebSocket carries. A string is a text frame (JSON), bytes are a binary frame (protobuf).
export type Frame = string | Uint8Array;

// Turn a message into a wire frame in the chosen encoding.
export function encode<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>, encoding: Encoding): Frame {
  return encoding === "json" ? toJsonString(schema, message) : toBinary(schema, message);
}

// Turn a wire frame back into a message. Which encoding it was is read off the frame itself: a string
// arrived as JSON, bytes arrived as protobuf. This is the whole reason JSON and protobuf clients can
// share one server, each answered in its own kind.
export function decode<Desc extends DescMessage>(schema: Desc, frame: Frame): MessageShape<Desc> {
  return typeof frame === "string" ? fromJsonString(schema, frame) : fromBinary(schema, frame);
}

// Decode a frame straight to readable JSON for the dev console, so a logged binary snapshot reads as
// cleanly as a JSON one. This is the ten-line debug hook the plan calls for: with the schema in hand a
// protobuf blob prints as plain fields, which beats staring at hex in the network tab.
export function describeFrame<Desc extends DescMessage>(schema: Desc, frame: Frame): unknown {
  return toJson(schema, decode(schema, frame));
}
