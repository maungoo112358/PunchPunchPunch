import { create } from "@bufbuild/protobuf";
import { createConnection } from "./connection.js";
import { encode, decode, type Encoding } from "./codec.js";
import { ClientMessageSchema, ServerMessageSchema } from "./gen/game_pb.js";
import type { Welcome, Join, Leave, Snapshot, Pong } from "./gen/game_pb.js";
import type { MoveInput } from "../systems/sim.js";

// The game's own view of the socket: send your input, and be told what the server says. It owns the two
// message schemas and the encoding, so the rest of the game passes plain records and reads plain
// messages, never touching protobuf or JSON.
//
// Step 9 uses JSON on the wire so every frame reads plainly in devtools and the server log. Flipping to
// protobuf is the one line below; the per-connection choice from the socket URL comes at step 14.
const ENCODING: Encoding = "json";

// The four things the server can tell us. Whoever creates the session hands these in, and each incoming
// frame is decoded once here and routed to the matching one.
export type ServerHandlers = {
  onWelcome(welcome: Welcome): void;
  onJoin(join: Join): void;
  onLeave(leave: Leave): void;
  onSnapshot(snapshot: Snapshot): void;
  onPong(pong: Pong): void;
};

export function createSession(url: string, handlers: ServerHandlers) {
  const connection = createConnection(url, (frame) => {
    const message = decode(ServerMessageSchema, frame);
    switch (message.body.case) {
      case "welcome":
        handlers.onWelcome(message.body.value);
        break;
      case "join":
        handlers.onJoin(message.body.value);
        break;
      case "leave":
        handlers.onLeave(message.body.value);
        break;
      case "snapshot":
        handlers.onSnapshot(message.body.value);
        break;
      case "pong":
        handlers.onPong(message.body.value);
        break;
    }
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

    // Send a clock probe stamped with the current time, to be echoed back in a pong.
    sendPing(clientTime: number) {
      const message = create(ClientMessageSchema, { body: { case: "ping", value: { clientTime } } });
      connection.send(encode(ClientMessageSchema, message, ENCODING));
    },

    close() {
      connection.close();
    },
  };
}

export type Session = ReturnType<typeof createSession>;
