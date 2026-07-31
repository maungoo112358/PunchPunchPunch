import { create } from "@bufbuild/protobuf";
import { createConnection } from "./connection.js";
import { encode, decode, type Encoding } from "./codec.js";
import { ClientMessageSchema, ServerMessageSchema, VoiceSignal_Kind } from "./gen/game_pb.js";
import type { Welcome, Join, Leave, Snapshot, Pong, VoiceSignal } from "./gen/game_pb.js";
import type { MoveInput } from "../systems/sim.js";

// The game's own view of the socket: send your input, and be told what the server says. It owns the two
// message schemas and the encoding, so the rest of the game passes plain records and reads plain
// messages, never touching protobuf or JSON.

// Everything the server can tell us. Whoever creates the session hands these in, and each incoming frame
// is decoded once here and routed to the matching one.
export type ServerHandlers = {
  onWelcome(welcome: Welcome): void;
  onJoin(join: Join): void;
  onLeave(leave: Leave): void;
  onSnapshot(snapshot: Snapshot): void;
  onPong(pong: Pong): void;
  // One step of another player's voice handshake, relayed by the server. Optional because voice is a
  // plug-in: leave it out and the signals are decoded and dropped, and everything else works as before.
  onVoice?(signal: VoiceSignal): void;
};

// Re-exported so the voice code can name the three handshake steps without reaching into the generated
// file itself. Kind.OFFER, Kind.ANSWER, Kind.CANDIDATE.
export { VoiceSignal_Kind as VoiceKind };
export type { VoiceSignal };

export function createSession(url: string, handlers: ServerHandlers) {
  // The wire encoding. JSON by default so frames read plainly in devtools and the server log; the demo
  // flips this live and the server follows, because it replies in whatever kind of frame we last sent.
  let encoding: Encoding = "json";

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
      case "voice":
        handlers.onVoice?.(message.body.value);
        break;
    }
  });

  return {
    get status() {
      return connection.status;
    },
    get encoding() {
      return encoding;
    },
    get bytesUp() {
      return connection.bytesUp;
    },
    get bytesDown() {
      return connection.bytesDown;
    },

    // Flip the wire encoding live. The next frame goes out in it, and the server replies in kind.
    setEncoding(e: Encoding) {
      encoding = e;
    },

    // Added round-trip latency in ms, for the demo slider.
    setLatency(ms: number) {
      connection.setLatency(ms);
    },

    // Encode one tick's input as a ClientMessage and send it up.
    sendInput(input: MoveInput) {
      const message = create(ClientMessageSchema, {
        body: {
          case: "input",
          value: {
            seq: input.seq,
            dir: { x: input.dir.x, y: input.dir.y, z: input.dir.z },
            attack: input.attack,
            aim: { x: input.aim.x, y: input.aim.y, z: input.aim.z },
          },
        },
      });
      connection.send(encode(ClientMessageSchema, message, encoding));
    },

    // Send a clock probe stamped with the current time, to be echoed back in a pong.
    sendPing(clientTime: number) {
      const message = create(ClientMessageSchema, { body: { case: "ping", value: { clientTime } } });
      connection.send(encode(ClientMessageSchema, message, encoding));
    },

    // Send one step of the voice handshake to another player. peer is who it is for on the way up; the
    // server swaps it for the sender's id on the way back down, so the receiver reads the same field to
    // learn who it came from. payload is whatever the browser produced for this step, passed through
    // untouched by everything between here and the other browser.
    sendVoice(peer: string, kind: VoiceSignal_Kind, payload: string) {
      const message = create(ClientMessageSchema, {
        body: { case: "voice", value: { peer, kind, payload } },
      });
      connection.send(encode(ClientMessageSchema, message, encoding));
    },

    close() {
      connection.close();
    },

    // Reconnect after a deliberate close, used when a tab that went away comes back.
    reopen() {
      connection.reopen();
    },
  };
}

export type Session = ReturnType<typeof createSession>;
