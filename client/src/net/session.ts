import { create } from "@bufbuild/protobuf";
import { createConnection } from "./connection.js";
import { encode, decode, type Encoding } from "./codec.js";
import { ClientMessageSchema, ServerMessageSchema, type Snapshot } from "./gen/game_pb.js";
import type { MoveInput } from "../systems/sim.js";

// The game's own view of the socket: send your input, and be told when a snapshot arrives. It owns the
// two message schemas and the encoding, so the rest of the game passes plain records and reads plain
// snapshots, never touching protobuf or JSON.
//
// Step 9 uses JSON on the wire so every frame reads plainly in devtools and the server log. Flipping to
// protobuf is the one line below; the per-connection choice from the socket URL comes at step 14.
const ENCODING: Encoding = "json";

export function createSession(url: string, onSnapshot: (snapshot: Snapshot) => void) {
  const connection = createConnection(url, (frame) => {
    const message = decode(ServerMessageSchema, frame);
    if (message.body.case === "snapshot") onSnapshot(message.body.value);
  });

  return {
    get status() {
      return connection.status;
    },

    // Encode one tick's input as a ClientMessage and send it up.
    sendInput(input: MoveInput) {
      const message = create(ClientMessageSchema, {
        body: {
          case: "input",
          value: { seq: input.seq, dir: { x: input.dir.x, y: input.dir.y, z: input.dir.z } },
        },
      });
      connection.send(encode(ClientMessageSchema, message, ENCODING));
    },

    close() {
      connection.close();
    },
  };
}

export type Session = ReturnType<typeof createSession>;
