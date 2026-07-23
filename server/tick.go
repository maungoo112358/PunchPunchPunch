package main

// The tick loop, the server half of the fixed-tick clock the client runs in main.ts. Thirty times a
// second it drains one input per player, steps the shared walk (sim.Step, the same code the golden test
// pins to the client), and sends everyone a snapshot. This is the first thing that puts a real player
// position on the wire.

import (
	"context"
	"log"
	"time"

	pb "punchpunchpunch/server/gen/gamepb"
	"punchpunchpunch/server/sim"
	"punchpunchpunch/server/wire"

	"github.com/coder/websocket"
)

// tickInterval is the wall-clock gap between ticks, taken from the sim's own tick rate so the loop and
// the walk can never drift onto different clocks. A second divided into TickHz even slices.
const tickInterval = time.Second / sim.TickHz

// writeTimeout bounds how long a single snapshot send may block. A stalled client must not hold up
// everyone else's tick, so a send that cannot finish this quickly is abandoned and the read side is left
// to notice the dead connection and clean it up.
const writeTimeout = 200 * time.Millisecond

// runTicks drives the loop until the context is cancelled at shutdown.
func (s *server) runTicks(ctx context.Context) {
	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.tick(ctx)
		}
	}
}

// tick advances every player by one step and sends each a snapshot. It reads the connection set once
// under the hub lock, then does the sim and the sending on that copy; a client that joins or leaves
// mid-tick is simply caught on the next one.
func (s *server) tick(ctx context.Context) {
	clients := s.hub.All()
	if len(clients) == 0 {
		return
	}
	s.tickNum++

	// Advance each player by one input, or hold still if none arrived in time for this tick.
	for _, c := range clients {
		if in, ok := c.drainOne(); ok {
			c.state = sim.Step(c.state, in, s.planet, s.path, sim.TickDT)
			c.lastSeq = uint32(in.Seq)
		} else {
			c.state = sim.Step(c.state, sim.Input{}, s.planet, s.path, sim.TickDT)
		}
	}

	// One players list, shared by every snapshot. Only the ack differs per recipient, because it is that
	// client's own last processed input, which is how they will later tell which predictions are confirmed.
	players := make([]*pb.PlayerSnapshot, 0, len(clients))
	for _, c := range clients {
		players = append(players, &pb.PlayerSnapshot{
			Id:       c.ID,
			PlanetId: 0,
			Position: vecToPB(c.state.Position),
			Forward:  vecToPB(c.state.Forward),
			Anim:     c.state.Anim,
		})
	}

	for _, c := range clients {
		msg := &pb.ServerMessage{Body: &pb.ServerMessage_Snapshot{Snapshot: &pb.Snapshot{
			Tick:    s.tickNum,
			Ack:     c.lastSeq,
			Players: players,
		}}}
		data, text, err := wire.Encode(msg, c.enc)
		if err != nil {
			log.Printf("encode snapshot for %s: %v", c.ID, err)
			continue
		}
		if err := c.send(ctx, data, text); err != nil {
			log.Printf("send  %s failed: %v", c.ID, err)
		}
	}
}

// send writes one already-encoded frame, as a text frame for JSON or a binary frame for protobuf, under
// a short deadline so a slow client cannot stall the tick.
func (c *Client) send(ctx context.Context, data []byte, text bool) error {
	kind := websocket.MessageBinary
	if text {
		kind = websocket.MessageText
	}
	writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return c.conn.Write(writeCtx, kind, data)
}

// vecToPB copies a sim vector into a protobuf one.
func vecToPB(v sim.Vec3) *pb.Vec3 { return &pb.Vec3{X: v.X, Y: v.Y, Z: v.Z} }

// pbToInput turns a decoded protobuf Input into the sim's Input, reading a missing dir as a zero vector,
// which the sim treats as standing still.
func pbToInput(in *pb.Input) sim.Input {
	dir := sim.Vec3{}
	if d := in.GetDir(); d != nil {
		dir = sim.Vec3{X: d.X, Y: d.Y, Z: d.Z}
	}
	return sim.Input{Seq: int(in.Seq), Dir: dir}
}
