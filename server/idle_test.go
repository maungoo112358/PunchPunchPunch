package main

// The idle kick, both halves: a silent connection gets dropped, a sending one stays alive. The idle
// window is set tiny here so the test runs in a blink instead of the 30 seconds the box uses. It stands
// up the real handleWS behind an httptest server and talks to it with a real WebSocket client, so it
// exercises the actual read-deadline path, not a stub.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	pb "punchpunchpunch/server/gen/gamepb"
	"punchpunchpunch/server/wire"

	"github.com/coder/websocket"
)

// dialTestServer starts a server with the given idle window and returns a connected client. The Go
// WebSocket client sends no Origin header, so the allowlist lets it straight through, which is why the
// origins here can be anything.
func dialTestServer(t *testing.T, idle time.Duration) (*websocket.Conn, context.Context) {
	t.Helper()
	s := &server{hub: NewHub(), origins: []string{"*"}, idle: idle}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)

	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)

	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return conn, ctx
}

func TestIdleKickDropsSilentClient(t *testing.T) {
	conn, ctx := dialTestServer(t, 100*time.Millisecond)

	// Say nothing and wait to be read. When the server drops us for idling this read returns an error.
	start := time.Now()
	if _, _, err := conn.Read(ctx); err == nil {
		t.Fatal("a silent client was not dropped")
	}
	if waited := time.Since(start); waited > time.Second {
		t.Fatalf("drop took %s, far longer than the 100ms idle window", waited)
	}
}

func TestSendingClientStaysAlive(t *testing.T) {
	conn, ctx := dialTestServer(t, 100*time.Millisecond)

	// A tiny keep-alive message. Its contents do not matter here, only that it arrives and resets the
	// clock. Send every 30ms for 400ms, which is four times the idle window, and every write must land.
	// If the reset were broken the server would close at 100ms and the write just after would fail.
	msg := &pb.ClientMessage{Body: &pb.ClientMessage_Input{Input: &pb.Input{Seq: 1}}}
	data, _, err := wire.Encode(msg, wire.Protobuf)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	deadline := time.Now().Add(400 * time.Millisecond)
	for time.Now().Before(deadline) {
		if err := conn.Write(ctx, websocket.MessageBinary, data); err != nil {
			t.Fatalf("connection died while still sending: %v", err)
		}
		time.Sleep(30 * time.Millisecond)
	}
}
