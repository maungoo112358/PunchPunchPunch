package main

// The voice mailbox: a handshake message addressed to another player reaches them, with peer rewritten
// from "who this is for" into "who this came from". Runs the real handler over two real sockets, because
// the rewrite is the only thing this server does for voice and it is easy to get backwards.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	pb "punchpunchpunch/server/gen/gamepb"
	"punchpunchpunch/server/sim"
	"punchpunchpunch/server/wire"

	"github.com/coder/websocket"
)

// voiceTestServer is the same real server the membership tests raise, with the tick loop running so
// joiners get their Welcome and learn their own id.
func voiceTestServer(t *testing.T) (*server, string, context.Context) {
	t.Helper()

	planet := sim.NewPlanet()
	path := sim.NewPath(planet.Radius)
	s := &server{
		hub:      NewHub(),
		origins:  []string{"*"},
		idle:     0,
		planet:   planet,
		path:     &path,
		spawn:    sim.Vec3{X: 0, Y: sim.PlanetRadius, Z: 0},
		welcomed: make(map[string]*Client),
		store:    newMemStore(),
		pool:     newPool(),
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go s.runTicks(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)

	rw, cancelRW := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancelRW)

	return s, "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws", rw
}

// sendVoice writes one handshake message up a socket, the way a browser would.
func sendVoice(t *testing.T, conn *websocket.Conn, ctx context.Context, peer string, kind pb.VoiceSignal_Kind, payload string) {
	t.Helper()
	msg := &pb.ClientMessage{Body: &pb.ClientMessage_Voice{Voice: &pb.VoiceSignal{
		Peer: peer, Kind: kind, Payload: payload,
	}}}
	data, _, err := wire.Encode(msg, wire.JSON)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestVoiceSignalReachesThePeer(t *testing.T) {
	_, url, rw := voiceTestServer(t)

	c1, _, err := websocket.Dial(rw, url, nil)
	if err != nil {
		t.Fatalf("first dial: %v", err)
	}
	defer c1.CloseNow()
	firstID := waitFor(t, c1, rw, func(m *pb.ServerMessage) bool { return m.GetWelcome() != nil }).GetWelcome().You.Id

	c2, _, err := websocket.Dial(rw, url, nil)
	if err != nil {
		t.Fatalf("second dial: %v", err)
	}
	defer c2.CloseNow()
	secondID := waitFor(t, c2, rw, func(m *pb.ServerMessage) bool { return m.GetWelcome() != nil }).GetWelcome().You.Id

	// The awkward payload from the codec test: a real audio description is many carriage-return-newline
	// separated lines, and it has to arrive byte for byte or the far browser cannot read it.
	const payload = "v=0\r\no=- 46117 2 IN IP4 127.0.0.1\r\ns=-\r\n"
	sendVoice(t, c1, rw, secondID, pb.VoiceSignal_KIND_OFFER, payload)

	got := waitFor(t, c2, rw, func(m *pb.ServerMessage) bool { return m.GetVoice() != nil }).GetVoice()
	// The rewrite: the second player asked for nothing, and must be told who is calling them.
	if got.Peer != firstID {
		t.Fatalf("peer is %q, want the sender %q", got.Peer, firstID)
	}
	if got.Kind != pb.VoiceSignal_KIND_OFFER {
		t.Fatalf("kind is %v, want KIND_OFFER", got.Kind)
	}
	if got.Payload != payload {
		t.Fatalf("payload changed in transit\n want: %q\n got:  %q", payload, got.Payload)
	}
}

func TestVoiceSignalToNobodyIsDropped(t *testing.T) {
	_, url, rw := voiceTestServer(t)

	c1, _, err := websocket.Dial(rw, url, nil)
	if err != nil {
		t.Fatalf("first dial: %v", err)
	}
	defer c1.CloseNow()
	firstID := waitFor(t, c1, rw, func(m *pb.ServerMessage) bool { return m.GetWelcome() != nil }).GetWelcome().You.Id

	c2, _, err := websocket.Dial(rw, url, nil)
	if err != nil {
		t.Fatalf("second dial: %v", err)
	}
	defer c2.CloseNow()
	waitFor(t, c2, rw, func(m *pb.ServerMessage) bool { return m.GetWelcome() != nil })

	// Three that must all go nowhere: a player who was never here, the sender addressing itself, and a
	// payload past the cap. None may reach the other player, and none may take the sender's socket down.
	sendVoice(t, c1, rw, "p9999", pb.VoiceSignal_KIND_OFFER, "ignored")
	sendVoice(t, c1, rw, firstID, pb.VoiceSignal_KIND_OFFER, "ignored")
	sendVoice(t, c1, rw, "p2", pb.VoiceSignal_KIND_OFFER, strings.Repeat("x", maxSignalPayload+1))

	// A ping behind them acts as a marker. It is answered from the same goroutine in the same order, so
	// its pong coming back proves the three above were handled and none of them wedged the read loop.
	ping := &pb.ClientMessage{Body: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTime: 1}}}
	data, _, err := wire.Encode(ping, wire.JSON)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if err := c1.Write(rw, websocket.MessageText, data); err != nil {
		t.Fatalf("write ping: %v", err)
	}
	waitFor(t, c1, rw, func(m *pb.ServerMessage) bool { return m.GetPong() != nil })

	// Now check the other player never heard any of it. Reading with a short deadline: a voice message
	// arriving here is a failure, and a timeout is the pass.
	quiet, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	for {
		kind, frame, err := c2.Read(quiet)
		if err != nil {
			return // the deadline fired with nothing delivered, which is the point
		}
		var msg pb.ServerMessage
		if err := wire.Decode(&msg, frame, kind == websocket.MessageText); err != nil {
			continue
		}
		if msg.GetVoice() != nil {
			t.Fatalf("a dropped signal was delivered anyway: %v", msg.GetVoice())
		}
	}
}
