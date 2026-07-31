package main

// Join handshake and despawn: a joiner gets a Welcome naming itself, an existing player gets a Join when
// a second connects, and a Leave when that second goes. Runs the real handler and tick loop, and filters
// the message stream exactly the way a real client does.

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

func TestJoinRosterAndLeave(t *testing.T) {
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
	defer cancel()
	go s.runTicks(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	ts := httptest.NewServer(mux)
	defer ts.Close()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"

	rw, cancelRW := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelRW()

	// First client connects and gets a Welcome: its own id, and an empty roster because it is alone.
	c1, _, err := websocket.Dial(rw, url, nil)
	if err != nil {
		t.Fatalf("dial c1: %v", err)
	}
	defer c1.CloseNow()

	welcome := waitFor(t, c1, rw, func(m *pb.ServerMessage) bool { return m.GetWelcome() != nil }).GetWelcome()
	if welcome.You == nil || welcome.You.Id == "" {
		t.Fatal("welcome carried no self info")
	}
	if welcome.You.Character == "" || welcome.You.Name == "" {
		t.Fatalf("welcome should assign a character and name, got character=%q name=%q", welcome.You.Character, welcome.You.Name)
	}
	// The roster is everyone already here, which for the first joiner is nobody except the training
	// dummy. It rides along as an ordinary player so the client draws and targets it with no special
	// case (dummy.go), which means it shows up here too.
	if len(welcome.Players) != 1 || welcome.Players[0].Id != dummyID {
		t.Fatalf("the first joiner's roster should hold only the training dummy, got %d entries", len(welcome.Players))
	}
	firstID := welcome.You.Id

	// Second client connects; the first should be told about it with a Join.
	c2, _, err := websocket.Dial(rw, url, nil)
	if err != nil {
		t.Fatalf("dial c2: %v", err)
	}

	join := waitFor(t, c1, rw, func(m *pb.ServerMessage) bool { return m.GetJoin() != nil }).GetJoin()
	joinedID := join.Player.Id
	if joinedID == firstID {
		t.Fatalf("a join should name the newcomer, not the existing player %s", firstID)
	}

	// Second client leaves; the first should get a Leave naming it.
	c2.Close(websocket.StatusNormalClosure, "bye")

	leave := waitFor(t, c1, rw, func(m *pb.ServerMessage) bool { return m.GetLeave() != nil }).GetLeave()
	if leave.Id != joinedID {
		t.Fatalf("leave named %s, expected the departed %s", leave.Id, joinedID)
	}
}

// waitFor reads from conn until match is happy or the context ends, ignoring the snapshots and anything
// else that streams past in between, which is how a real client picks the message it cares about.
func waitFor(t *testing.T, conn *websocket.Conn, ctx context.Context, match func(*pb.ServerMessage) bool) *pb.ServerMessage {
	t.Helper()
	for {
		kind, frame, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read while waiting for a message: %v", err)
		}
		var msg pb.ServerMessage
		if err := wire.Decode(&msg, frame, kind == websocket.MessageText); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if match(&msg) {
			return &msg
		}
	}
}
