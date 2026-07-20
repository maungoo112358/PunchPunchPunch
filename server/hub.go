package main

import (
	"strconv"
	"sync"

	"github.com/coder/websocket"
)

// Who is connected right now. Nothing about the game yet: no positions, no players, just sockets and
// the ids we gave them. The game state lands on top of this in step 9.
//
// Every field is behind the mutex because connections arrive and leave on their own goroutines. Go
// gives each connection its own thread of execution, so two people can join in the same instant and
// both reach for this map. Unity's main-thread-only rule means you rarely think about that; here it is
// the normal case, and forgetting the lock gives you a crash that only happens under load.

// Client is one connected socket.
type Client struct {
	ID   string
	Addr string // where they connected from, for the log
	conn *websocket.Conn
}

type Hub struct {
	mu      sync.Mutex
	clients map[string]*Client
	nextID  int64
}

func NewHub() *Hub {
	return &Hub{clients: make(map[string]*Client)}
}

// Add registers a socket and hands back the client, with the id already assigned. Ids are just a
// counter for now. Step 12 gives players a real name and a character to go with it.
func (h *Hub) Add(conn *websocket.Conn, addr string) *Client {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.nextID++
	c := &Client{
		ID:   "p" + strconv.FormatInt(h.nextID, 10),
		Addr: addr,
		conn: conn,
	}
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
