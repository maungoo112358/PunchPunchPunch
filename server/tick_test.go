package main

// The tick loop end to end: connect, send a run input, and confirm the snapshots coming back show the
// player leaving the spawn. This is the automated form of the plan's "two browsers, one moves, the other
// sees the numbers change", with one client watching its own movement instead of a second browser. It
// runs the real handler and the real loop; only the clock is sped up by there being nothing else to do.

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

func TestTickLoopMovesAndBroadcasts(t *testing.T) {
	planet := sim.NewPlanet()
	path := sim.NewPath(planet.Radius)
	s := &server{
		hub:      NewHub(),
		origins:  []string{"*"},
		idle:     0, // no idle kick while the test holds a socket open
		planet:   planet,
		path:     &path,
		spawn:    sim.Vec3{X: 0, Y: sim.PlanetRadius, Z: 0},
		welcomed: make(map[string]bool),
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.runTicks(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	ts := httptest.NewServer(mux)
	defer ts.Close()

	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	dialCtx, dialCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dialCancel()
	conn, _, err := websocket.Dial(dialCtx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	// "Run sideways off the pole." dir length 1 is a run; the exact direction only has to be tangent to
	// the surface, which any horizontal vector is at the north pole. Encoded once and resent each loop.
	input := &pb.ClientMessage{Body: &pb.ClientMessage_Input{Input: &pb.Input{Seq: 1, Dir: &pb.Vec3{X: 1, Y: 0, Z: 0}}}}
	data, _, err := wire.Encode(input, wire.JSON)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	rw, cancelRW := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancelRW()

	moved := false
	for i := 0; i < 60 && !moved; i++ {
		if err := conn.Write(rw, websocket.MessageText, data); err != nil {
			t.Fatalf("write: %v", err)
		}
		kind, frame, err := conn.Read(rw)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var msg pb.ServerMessage
		if err := wire.Decode(&msg, frame, kind == websocket.MessageText); err != nil {
			t.Fatalf("decode: %v", err)
		}
		snap := msg.GetSnapshot()
		if snap == nil {
			continue // the Welcome, and later the roster, arrive before and between snapshots
		}
		if len(snap.Players) != 1 {
			t.Fatalf("expected 1 player in the snapshot, got %d", len(snap.Players))
		}
		p := snap.Players[0].Position
		dx, dy, dz := p.X-s.spawn.X, p.Y-s.spawn.Y, p.Z-s.spawn.Z
		if dx*dx+dy*dy+dz*dz > 0.01 {
			moved = true
		}
	}
	if !moved {
		t.Fatal("player never left the spawn after sending run inputs")
	}
}
