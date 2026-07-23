package main

// A ping comes back as a pong that echoes the client's timestamp and carries the server's tick. That is
// the whole basis of the clock handshake: the echo gives the client its round trip, the tick gives it the
// server's clock.

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

func TestPingIsAnsweredWithPong(t *testing.T) {
	planet := sim.NewPlanet()
	path := sim.NewPath(planet.Radius)
	s := &server{
		hub:      NewHub(),
		origins:  []string{"*"},
		idle:     0,
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

	rw, cancelRW := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelRW()
	conn, _, err := websocket.Dial(rw, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	const stamp = 12345.5
	ping := &pb.ClientMessage{Body: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTime: stamp}}}
	data, _, err := wire.Encode(ping, wire.JSON)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if err := conn.Write(rw, websocket.MessageText, data); err != nil {
		t.Fatalf("write: %v", err)
	}

	pong := waitFor(t, conn, rw, func(m *pb.ServerMessage) bool { return m.GetPong() != nil }).GetPong()
	if pong.ClientTime != stamp {
		t.Fatalf("pong echoed client_time %v, want %v", pong.ClientTime, stamp)
	}
}
