package main

// The tick loop, the server half of the fixed-tick clock the client runs in main.ts. Thirty times a
// second it drains one input per player, steps the shared walk (sim.Step, the same code the golden test
// pins to the client), and sends everyone a snapshot. This is the first thing that puts a real player
// position on the wire.

import (
	"context"
	"fmt"
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

// tick reconciles who is playing, then advances and broadcasts them. Membership first, in this order, so
// a Welcome or a Join always reaches a client before the first snapshot that mentions the new player, and
// a Leave reaches them before the snapshot that drops the one who left. Doing it all here keeps the tick
// loop the single writer to every socket.
func (s *server) tick(ctx context.Context) {
	all := s.hub.All()
	current := make(map[string]*Client, len(all))
	for _, c := range all {
		current[c.ID] = c
	}

	s.handleLeaves(ctx, current)
	s.handleJoins(ctx, all, current)

	if len(s.welcomed) == 0 {
		return
	}
	tick := s.tickNum.Add(1)

	// Advance each player by one input, or hold still if none arrived in time for this tick.
	for id := range s.welcomed {
		c := current[id]
		if in, ok := c.drainOne(); ok {
			c.state = sim.Step(c.state, in, s.planet, s.path, sim.TickDT)
			c.lastSeq = uint32(in.Seq)
		} else {
			c.state = sim.Step(c.state, sim.Input{}, s.planet, s.path, sim.TickDT)
		}
	}

	// One players list, shared by every snapshot. Only the ack differs per recipient, because it is that
	// client's own last processed input, which is how they later tell which predictions are confirmed.
	players := make([]*pb.PlayerSnapshot, 0, len(s.welcomed))
	for id := range s.welcomed {
		c := current[id]
		players = append(players, &pb.PlayerSnapshot{
			Id:       c.ID,
			PlanetId: 0,
			Position: vecToPB(c.state.Position),
			Forward:  vecToPB(c.state.Forward),
			Anim:     c.state.Anim,
		})
	}

	for id := range s.welcomed {
		c := current[id]
		s.sendMsg(ctx, c, &pb.ServerMessage{Body: &pb.ServerMessage_Snapshot{Snapshot: &pb.Snapshot{
			Tick:    tick,
			Ack:     c.lastSeq,
			Players: players,
		}}})
	}
}

// handleLeaves finds welcomed players who are no longer connected, tells the rest they are gone, and
// forgets them. Gone ids are collected first so the welcomed map is not mutated while being ranged.
func (s *server) handleLeaves(ctx context.Context, current map[string]*Client) {
	var gone []string
	for id := range s.welcomed {
		if _, ok := current[id]; !ok {
			gone = append(gone, id)
		}
	}
	for _, id := range gone {
		c := s.welcomed[id] // the last Client we had for them, its state stepped by this same goroutine

		// Stats plug-in: save a logged-in account's final position and updated counters before forgetting
		// them. It reads the Client the tick loop last stepped, from the tick loop, so there is no race
		// with the stepping. The write is disk I/O done inline, which is fine because leaves are rare; if
		// it ever needs to stay off the tick, copy the Stats value out and Save it on another goroutine.
		if c != nil && c.accountKey != "" {
			c.stats.PlaySeconds += int(time.Since(c.joinedAt).Seconds())
			c.stats.Pos = c.state.Position
			c.stats.Fwd = c.state.Forward
			if err := s.store.Save(c.accountKey, c.stats); err != nil {
				log.Printf("save  %s failed: %v", c.accountKey, err)
			} else {
				log.Printf("save  %s: visit #%d, %ds played total", c.accountKey, c.stats.Visits, c.stats.PlaySeconds)
			}
		}
		delete(s.welcomed, id)
		leave := &pb.ServerMessage{Body: &pb.ServerMessage_Leave{Leave: &pb.Leave{Id: id}}}
		for other := range s.welcomed {
			s.sendMsg(ctx, current[other], leave)
		}
		log.Printf("leave %s (%d playing)", id, len(s.welcomed))
		if c != nil {
			s.presence.left(c.name, fmt.Sprintf("👋 %s the %s left — %d online", c.name, c.character, len(s.welcomed)))
		}
	}
}

// handleJoins finds connected players not yet welcomed, hands each the roster and its own id, tells the
// others about the newcomer, and marks it in play.
func (s *server) handleJoins(ctx context.Context, all []*Client, current map[string]*Client) {
	for _, c := range all {
		if _, ok := s.welcomed[c.ID]; ok {
			continue
		}
		// Stats plug-in: a logged-in account loads its saved spot and counters on the way in, so it
		// resumes where it left off; a first visit starts a fresh row. Guests carry no key and skip it.
		// Position is applied to the state here and reaches the client through the first snapshot's
		// reconciliation, not the Welcome, so the Welcome below is unchanged.
		if c.accountKey != "" {
			st, found := s.store.Load(c.accountKey)
			if found {
				c.state.Position = st.Pos
				c.state.Forward = st.Fwd
				log.Printf("load  %s: visit #%d incoming, %ds played, resuming at (%.1f,%.1f,%.1f)",
					c.accountKey, st.Visits+1, st.PlaySeconds, st.Pos.X, st.Pos.Y, st.Pos.Z)
			} else {
				log.Printf("load  %s: first visit", c.accountKey)
			}
			st.Visits++
			c.stats = st
			c.joinedAt = time.Now()
		}
		// The roster is everyone welcomed so far, which excludes this newcomer since it is not in the set
		// yet. If two join on the same tick the first is added before the second's roster is built, so the
		// second sees the first.
		roster := make([]*pb.PlayerInfo, 0, len(s.welcomed))
		for other := range s.welcomed {
			roster = append(roster, playerInfo(current[other]))
		}
		s.sendMsg(ctx, c, &pb.ServerMessage{Body: &pb.ServerMessage_Welcome{Welcome: &pb.Welcome{
			You:     playerInfo(c),
			Players: roster,
		}}})

		join := &pb.ServerMessage{Body: &pb.ServerMessage_Join{Join: &pb.Join{Player: playerInfo(c)}}}
		for other := range s.welcomed {
			s.sendMsg(ctx, current[other], join)
		}

		s.welcomed[c.ID] = c
		log.Printf("welcome %s (%d playing)", c.ID, len(s.welcomed))
		s.presence.joined(c.name, fmt.Sprintf("🟢 %s the %s joined — %d online", c.name, c.character, len(s.welcomed)))
	}
}

// sendMsg encodes one message in this client's chosen encoding and writes it. All sends go through here,
// from the tick loop only, so there is one writer per socket.
func (s *server) sendMsg(ctx context.Context, c *Client, msg *pb.ServerMessage) {
	if c == nil {
		return
	}
	data, text, err := wire.Encode(msg, c.encoding())
	if err != nil {
		log.Printf("encode for %s: %v", c.ID, err)
		return
	}
	if err := c.send(ctx, data, text); err != nil {
		log.Printf("send  %s failed: %v", c.ID, err)
	}
}

// playerInfo is the identity that rides join and roster messages: id, character and name. planetId is 0
// until a second planet exists.
func playerInfo(c *Client) *pb.PlayerInfo {
	return &pb.PlayerInfo{Id: c.ID, PlanetId: 0, Character: c.character, Name: c.name}
}

// send writes one already-encoded frame, as a text frame for JSON or a binary frame for protobuf, under
// a short deadline so a slow client cannot stall the tick. The mutex serialises it against any other
// goroutine sending on the same socket, which coder/websocket requires.
func (c *Client) send(ctx context.Context, data []byte, text bool) error {
	kind := websocket.MessageBinary
	if text {
		kind = websocket.MessageText
	}
	writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
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
