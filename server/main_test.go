package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Proof that the skeleton does its three jobs: accept a socket, keep count of who is connected, and
// turn away anyone from an origin we did not allow.
//
// It runs the real handler against a real HTTP server on a spare port, so what is being tested is the
// same code path a browser takes. Nothing is mocked.

// testServer starts the handler on a random free port and hands back the ws:// address to dial.
func testServer(t *testing.T) (*server, string) {
	t.Helper()

	s := &server{hub: NewHub(), origins: []string{"localhost:5173"}, pool: newPool()}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	httpServer := httptest.NewServer(mux)
	t.Cleanup(httpServer.Close)

	return s, "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"
}

func dial(t *testing.T, url, origin string) (*websocket.Conn, error) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	header := http.Header{}
	if origin != "" {
		header.Set("Origin", origin)
	}
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: header})
	return conn, err
}

// waitForCount gives the server a moment to notice a join or a drop. The client and the server run at
// their own pace, so "connected" happens a hair after Dial returns, and a drop lands a hair after
// Close. Polling briefly is honest about that; sleeping a fixed amount would be slower and flakier.
func waitForCount(t *testing.T, s *server, want int) {
	t.Helper()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s.hub.Count() == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("expected %d connected, got %d", want, s.hub.Count())
}

func TestClientsJoinAndDrop(t *testing.T) {
	s, url := testServer(t)

	first, err := dial(t, url, "http://localhost:5173")
	if err != nil {
		t.Fatalf("first client could not connect: %v", err)
	}
	waitForCount(t, s, 1)

	second, err := dial(t, url, "http://localhost:5173")
	if err != nil {
		t.Fatalf("second client could not connect: %v", err)
	}
	waitForCount(t, s, 2)

	// Two different sockets have to be two different players, or everything above this falls apart.
	if ids := s.hub.All(); ids[0].ID == ids[1].ID {
		t.Fatalf("both clients got the same id: %s", ids[0].ID)
	}

	first.Close(websocket.StatusNormalClosure, "done")
	waitForCount(t, s, 1)

	second.Close(websocket.StatusNormalClosure, "done")
	waitForCount(t, s, 0)
}

// The allowlist is the thing most likely to be quietly wrong once the client is served from a different
// domain than the server, and its failure looks like "the connection just does not work" in a browser.
// So it gets its own test.
func TestOriginNotOnTheListIsRefused(t *testing.T) {
	s, url := testServer(t)

	conn, err := dial(t, url, "http://somewhere-else.example")
	if err == nil {
		conn.Close(websocket.StatusNormalClosure, "")
		t.Fatal("a page from another origin was allowed to connect")
	}
	if s.hub.Count() != 0 {
		t.Fatalf("refused connection still counted, %d connected", s.hub.Count())
	}
}

// A message arriving before there is any protocol should be read and ignored, not crash the reader or
// drop the client. Step 7 gives these meaning.
func TestUnknownMessageDoesNotDropTheClient(t *testing.T) {
	s, url := testServer(t)

	conn, err := dial(t, url, "http://localhost:5173")
	if err != nil {
		t.Fatalf("could not connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "done")
	waitForCount(t, s, 1)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte("hello?")); err != nil {
		t.Fatalf("could not send: %v", err)
	}

	// Still there a moment later.
	time.Sleep(50 * time.Millisecond)
	if s.hub.Count() != 1 {
		t.Fatalf("client was dropped after sending a message, %d connected", s.hub.Count())
	}
}
