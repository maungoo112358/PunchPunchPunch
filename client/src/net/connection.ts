import type { Frame } from "./codec.js";

// The socket to the game server: dial, carry frames both ways, and dial again if the line drops. It
// deals only in frames, strings and bytes, and knows nothing about the game. Decoding those frames into
// messages is net/session.ts's job, one layer up.
//
// The address is baked in at build time from VITE_SERVER_URL. It is NOT worked out from the page's own
// hostname, because the page comes from slint.live and the server lives on api.slint.live, so "wherever
// the page came from" is the wrong answer here. docs/DEPLOYMENT.md has the long version.

// How long to wait before dialling again, doubling each failure so a server that is down does not get
// hammered, and capped so a player who leaves the tab open still reconnects within a few seconds of it
// coming back.
const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;

export type ConnectionStatus = "connecting" | "open" | "closed";

// Bytes in a frame, for the bytes-per-second readout. A JSON text frame is ASCII so its length is its
// byte count closely enough; a binary frame carries its exact length.
function frameSize(frame: Frame): number {
  return typeof frame === "string" ? frame.length : frame.byteLength;
}

// onFrame is called for every message that arrives, already unwrapped to a string (a text frame, JSON)
// or bytes (a binary frame, protobuf), which is exactly what the codec reads.
export function createConnection(url: string, onFrame?: (frame: Frame) => void) {
  let socket: WebSocket | null = null;
  let status: ConnectionStatus = "closed";
  let retryMs = FIRST_RETRY_MS;
  let retryTimer = 0;
  // Flips to false when we close on purpose, which is how a deliberate hang-up is told apart from a
  // dropped line. Without it, closing the socket would immediately reopen it.
  let wanted = true;

  // Fake latency for the demo: an added round trip, half held on the way out and half on the way in, so
  // the slider reads as total added RTT. And running byte totals, which the readout turns into a rate.
  let latencyMs = 0;
  let bytesUp = 0;
  let bytesDown = 0;

  function dial() {
    status = "connecting";
    console.log(`[net] connecting to ${url}`);
    socket = new WebSocket(url);
    // Without this a binary frame comes back as a Blob, which only reads asynchronously, and the decode
    // silently gets the wrong type. arraybuffer hands us the bytes directly. Harmless for JSON, which
    // arrives as a string either way, and needed the moment we flip to protobuf.
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      status = "open";
      retryMs = FIRST_RETRY_MS; // a good connection earns back the short retry
      console.log("[net] open");
    };

    socket.onmessage = (e) => {
      const frame: Frame = typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer);
      bytesDown += frameSize(frame);
      const half = latencyMs / 2;
      if (half > 0) window.setTimeout(() => onFrame?.(frame), half);
      else onFrame?.(frame);
    };

    // The browser fires error and then close for the same failure, and error carries no detail on
    // purpose (it would leak whether a host exists). So close is where the useful numbers are.
    socket.onerror = () => console.warn("[net] socket error");

    socket.onclose = (e) => {
      status = "closed";
      socket = null;
      console.log(`[net] closed, code ${e.code}${e.reason ? `, ${e.reason}` : ""}`);
      if (!wanted) return;
      console.log(`[net] retrying in ${retryMs}ms`);
      retryTimer = window.setTimeout(dial, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    };
  }

  dial();

  return {
    get status() {
      return status;
    },
    get bytesUp() {
      return bytesUp;
    },
    get bytesDown() {
      return bytesDown;
    },

    // Added round-trip latency in ms, for the demo slider. 0 turns it off.
    setLatency(ms: number) {
      latencyMs = Math.max(0, ms);
    },

    // Send a frame if the line is up, otherwise drop it. Dropping is fine: input is sent every tick, so
    // a frame lost while reconnecting is replaced a thirtieth of a second later. Held half the fake RTT
    // on the way out, matching the delay on the way in.
    send(frame: Frame) {
      const s = socket;
      if (!s || s.readyState !== WebSocket.OPEN) return;
      bytesUp += frameSize(frame);
      const half = latencyMs / 2;
      if (half > 0) window.setTimeout(() => { if (s.readyState === WebSocket.OPEN) s.send(frame); }, half);
      else s.send(frame);
    },

    // Hang up and stay hung up.
    close() {
      wanted = false;
      window.clearTimeout(retryTimer);
      socket?.close(1000, "client closing");
    },
  };
}

export type Connection = ReturnType<typeof createConnection>;
