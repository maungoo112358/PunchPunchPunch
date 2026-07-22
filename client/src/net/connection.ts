// The socket to the game server. Today it only proves the wire is real: it dials, says what happened in
// the console, and dials again if the line drops. Nothing crosses it yet, the messages arrive in step 7.
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

export function createConnection(url: string) {
  let socket: WebSocket | null = null;
  let status: ConnectionStatus = "closed";
  let retryMs = FIRST_RETRY_MS;
  let retryTimer = 0;
  // Flips to false when we close on purpose, which is how a deliberate hang-up is told apart from a
  // dropped line. Without it, closing the socket would immediately reopen it.
  let wanted = true;

  function dial() {
    status = "connecting";
    console.log(`[net] connecting to ${url}`);
    socket = new WebSocket(url);

    socket.onopen = () => {
      status = "open";
      retryMs = FIRST_RETRY_MS; // a good connection earns back the short retry
      console.log("[net] open");
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

    // Hang up and stay hung up.
    close() {
      wanted = false;
      window.clearTimeout(retryTimer);
      socket?.close(1000, "client closing");
    },
  };
}

export type Connection = ReturnType<typeof createConnection>;
