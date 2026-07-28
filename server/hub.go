package main

import (
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"punchpunchpunch/server/sim"
	"punchpunchpunch/server/wire"

	"github.com/coder/websocket"
)

// Who is connected right now, and where each of them is standing. The socket bookkeeping and the game
// state live together on the Client, because the tick loop walks this same set of connections to step
// everyone and send each of them a snapshot.
//
// Every access to the clients map is behind the mutex because connections arrive and leave on their own
// goroutines. Go gives each connection its own thread of execution, so two people can join in the same
// instant and both reach for this map. Unity's main-thread-only rule means you rarely think about that;
// here it is the normal case, and forgetting the lock gives you a crash that only happens under load.

// inboxSize is how many inputs a connection may have waiting for the next tick. A quarter second at 30
// ticks. Past this the newest is dropped, which is the flood protection: a client sending too fast, from
// lag or malice, cannot grow this without bound or make the tick spend forever draining it.
const inboxSize = 8

// Client is one connected socket and the player behind it.
type Client struct {
	ID   string
	Addr string // where they connected from, for the log
	conn *websocket.Conn

	// Guards writes to conn. Three different goroutines can reach for this socket at once: the tick loop
	// sending snapshots and membership, this connection's own read goroutine answering a ping, and
	// another player's read goroutine forwarding a voice handshake here. coder/websocket forbids
	// concurrent writes, so every send takes this first.
	writeMu sync.Mutex

	// The game state. Only the tick loop ever touches these, so they need no lock of their own: one
	// goroutine writes them, and it is the same one that reads them to build the snapshot.
	state   sim.PlayerState
	lastSeq uint32 // the last input seq the tick loop consumed, echoed back to this client as the ack

	// Inputs waiting for the next tick. A buffered channel instead of a slice plus a lock: the read
	// goroutine offers, the tick goroutine drains, and the channel handles the handoff safely.
	inbox chan sim.Input

	// How this connection wants its snapshots encoded. It follows whatever the client last sent: a text
	// frame is JSON, a binary frame is protobuf, so the client flips its own encoding and the server
	// replies in kind with no reconnect. Atomic because the read goroutine sets it while the tick loop
	// reads it. 0 is protobuf, 1 is json, matching wire.Encoding.
	enc atomic.Int32

	// Drawn from the pool when the socket opens, put back when it closes. character is a key the client
	// maps to a model; name floats over the head. They never change while connected, so they ride the
	// join and roster messages, not the snapshot.
	character string
	name      string

	// The stats plug-in. accountKey is the persistence key, set only for a logged-in account and empty
	// for a guest, so an empty key is how the tick loop knows not to load or save. joinedAt starts the
	// clock for this session's play time, and stats is the row loaded on join and written back on leave.
	// Only the tick loop touches joinedAt and stats, so they need no lock.
	accountKey string
	joinedAt   time.Time
	stats      Stats
}

func (c *Client) encoding() wire.Encoding     { return wire.Encoding(c.enc.Load()) }
func (c *Client) setEncoding(e wire.Encoding) { c.enc.Store(int32(e)) }

// offer queues an input for the next tick, dropping it if the inbox is already full. Non-blocking, so a
// flooding client can never stall the goroutine reading its socket. One dropped intent is one still
// tick, which is harmless because each input is an absolute intent, not a delta.
func (c *Client) offer(in sim.Input) {
	select {
	case c.inbox <- in:
	default:
	}
}

// drainOne takes the next queued input, or reports false if none arrived in time for this tick.
func (c *Client) drainOne() (sim.Input, bool) {
	select {
	case in := <-c.inbox:
		return in, true
	default:
		return sim.Input{}, false
	}
}

type Hub struct {
	mu      sync.Mutex
	clients map[string]*Client
	nextID  int64
}

func NewHub() *Hub {
	return &Hub{clients: make(map[string]*Client)}
}

// Add registers a socket and hands back the client, spawned and ready to be ticked. The character and
// name are drawn from the pool by the caller before this, so they are set here under the same lock that
// makes the client visible, and the tick loop never sees a client without them.
func (h *Hub) Add(conn *websocket.Conn, addr string, spawn sim.Vec3, character, name string) *Client {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.nextID++
	c := &Client{
		ID:        "p" + strconv.FormatInt(h.nextID, 10),
		Addr:      addr,
		conn:      conn,
		state:     sim.NewPlayerState(spawn, sim.Vec3{X: 0, Y: 0, Z: 1}),
		inbox:     make(chan sim.Input, inboxSize),
		character: character,
		name:      name,
	}
	c.setEncoding(wire.JSON) // start in JSON, the client's default, until it sends a frame that says otherwise
	h.clients[c.ID] = c
	return c
}

func (h *Hub) Remove(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, id)
}

func (h *Hub) Count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

// Get finds one client by id, or nil if nobody by that id is connected. Voice signalling uses it to hand
// a handshake message to the player it is addressed to. Nil is an ordinary answer here, not an error:
// the addressee may have left in the moment between the sender deciding to call them and this arriving.
func (h *Hub) Get(id string) *Client {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.clients[id]
}

// All hands back a copy of the current clients. A copy, so callers can take their time with the list
// without holding the lock and stalling everyone trying to join or leave.
func (h *Hub) All() []*Client {
	h.mu.Lock()
	defer h.mu.Unlock()

	out := make([]*Client, 0, len(h.clients))
	for _, c := range h.clients {
		out = append(out, c)
	}
	return out
}
