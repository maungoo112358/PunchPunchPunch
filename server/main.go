package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	pb "punchpunchpunch/server/gen/gamepb"
	"punchpunchpunch/server/sim"
	"punchpunchpunch/server/wire"

	"github.com/coder/websocket"
)

// The game server. Right now it does one thing: accept WebSocket connections, remember who is
// connected, and say so in the log when people come and go. No game, no messages, no tick. Those
// arrive in steps 7 and 9, and they all stand on this.
//
// Two terminals to run the whole thing: `go run .` here, `npm run dev` in client/.

// Settings come from the environment so the same binary runs on your machine and on the Lightsail box
// without a rebuild. Empty means "use the default below".
const (
	defaultAddr = ":8080"
	// Where the client is served from during development. Vite's dev server, on your machine and on
	// your phone over the local network.
	defaultOrigins = "localhost:5173,127.0.0.1:5173,*.local:5173"
	// How long a connection may go without sending anything before the server drops it. Once input
	// streams every tick (step 9) a real player resets this constantly, so a socket that stays silent
	// this long is an abandoned tab worth reaping. Overridable with IDLE_TIMEOUT, mostly so the test
	// can use a tiny value.
	defaultIdle = 30 * time.Second
	// The key that signs login tokens. The dev default lets the whole thing run out of the box; on the
	// box TOKEN_SECRET is set to a real random string so tokens minted here cannot be forged. A token
	// signed with one secret fails verification under another, which just drops the player back to a
	// pool name, so rotating it logs everyone out gently rather than breaking anything.
	defaultTokenSecret = "dev-secret-change-me"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envDuration(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
		log.Printf("bad %s %q, using %s", key, v, fallback)
	}
	return fallback
}

type server struct {
	hub     *Hub
	origins []string
	idle    time.Duration

	// The key that signs and verifies login tokens. Set once at boot, read on every login and every
	// socket open. See the login plug-in in auth.go.
	tokenSecret []byte

	// The world the tick loop simulates in. planet and path are the same math the client and the golden
	// test use; spawn is where a new player appears, the north pole, matching the client's spawn.
	planet sim.Planet
	path   *sim.Path
	spawn  sim.Vec3
	// counts up forever, stamped on every snapshot. Atomic because the tick loop bumps it while the read
	// goroutine reads it to answer a ping.
	tickNum atomic.Uint32

	// Who has been welcomed and is in play, each mapped to its Client. The tick loop diffs this against
	// the live connections each tick to find joins and leaves, so it stays the single writer to every
	// socket. Holding the Client, not just a flag, lets a leave still reach the player's final state to
	// save it after the socket is already gone from the hub. Only the tick loop touches it, so no lock.
	welcomed map[string]*Client

	// The bags of characters and names a joiner draws from. Guarded by its own lock because connections
	// draw and return concurrently.
	pool *pool

	// Where account stats are loaded and saved, the stats plug-in. Defaults to an in-memory map that
	// forgets on exit; becomes a SQLite file when STATS_DB names one. Touched only by the tick loop.
	store Store
}

func main() {
	addr := env("ADDR", defaultAddr)
	origins := strings.Split(env("ALLOWED_ORIGINS", defaultOrigins), ",")
	idle := envDuration("IDLE_TIMEOUT", defaultIdle)
	tokenSecret := env("TOKEN_SECRET", defaultTokenSecret)

	// The stats store. No STATS_DB means the in-memory map, which is the "plug-in removed" default and
	// what a fresh dev run uses; a path means a SQLite file that survives restarts. A bad path is fatal
	// on purpose, because silently forgetting to persist is worse than not starting.
	var store Store = newMemStore()
	if path := os.Getenv("STATS_DB"); path != "" {
		sq, err := newSQLiteStore(path)
		if err != nil {
			log.Fatalf("stats db %q: %v", path, err)
		}
		store = sq
		log.Printf("stats persisting to %s", path)
	}

	planet := sim.NewPlanet()
	path := sim.NewPath(planet.Radius)
	s := &server{
		hub:         NewHub(),
		origins:     origins,
		idle:        idle,
		tokenSecret: []byte(tokenSecret),
		planet:      planet,
		path:        &path,
		spawn:       sim.Vec3{X: 0, Y: planet.Radius, Z: 0}, // north pole, where up is +Y
		welcomed:    make(map[string]*Client),
		pool:        newPool(),
		store:       store,
	}
	defer store.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	// The login plug-in. Checks a seeded account and hands back a signed token the socket carries.
	mux.HandleFunc("/login", s.handleLogin)
	// Something to hit with a browser or a health check that is not a WebSocket, so "is it up" has an
	// easy answer. The deploy in step 6 uses this to know the box is alive.
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ok\n"))
	})

	httpServer := &http.Server{
		Addr:    addr,
		Handler: mux,
		// A slow or hostile client should not be able to hold a connection open forever during the
		// handshake. Once a socket is upgraded these no longer apply, which is what we want: a game
		// connection is meant to live for hours.
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Ctrl+C should close the door politely rather than yanking the plug: stop taking new connections,
	// give what is in flight a moment, then exit.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// The heartbeat. Steps every player and broadcasts a snapshot thirty times a second, until the
	// context is cancelled on shutdown.
	go s.runTicks(ctx)

	go func() {
		log.Printf("listening on %s, accepting origins %v, idle timeout %s", addr, origins, idle)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server stopped: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("shutting down, %d connected", s.hub.Count())

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown was not clean: %v", err)
	}
	for _, c := range s.hub.All() {
		c.conn.Close(websocket.StatusGoingAway, "server shutting down")
	}
	log.Print("stopped")
}

// handleWS turns an ordinary HTTP request into a WebSocket and then reads from it until it dies.
func (s *server) handleWS(w http.ResponseWriter, r *http.Request) {
	// OriginPatterns is the allowlist, and it is here from the first line on purpose. A browser sends
	// the page's origin with the handshake, and the library refuses anything not on this list. Under
	// split hosting the client is served from a different domain than this server, so without it every
	// connection is refused, and the browser reports that as a bare failure with nothing useful in the
	// console. Easier to write now than to debug at one in the morning.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.origins})
	if err != nil {
		log.Printf("handshake refused from %s: %v", r.RemoteAddr, err)
		return
	}

	// Resolve who this is, three ways, before registering. A valid login token names the player and the
	// character still comes from the pool. A guest resume, char and name in the query that the tab saved
	// on its first connect, asks for the same avatar back after a refresh. Otherwise a fresh random draw.
	// poolName is always what gets returned to the name bag on leave; name is what floats over the head,
	// which differs from poolName only when a login token renames them.
	q := r.URL.Query()
	accountName, loggedIn := verifyToken(q.Get("token"), s.tokenSecret)

	var character, poolName, name string
	var ok bool
	switch {
	case loggedIn:
		character, poolName, ok = s.pool.take()
		name = accountName
	case q.Get("char") != "":
		character, poolName, ok = s.pool.takeSpecific(q.Get("char"), q.Get("name"))
		if !ok { // their old character was taken in the gap, so give them a fresh one instead
			character, poolName, ok = s.pool.take()
		}
		name = poolName
	default:
		character, poolName, ok = s.pool.take()
		name = poolName
	}

	// An empty character bag means the game is full, and the honest answer for a demo is to turn the
	// connection away.
	if !ok {
		log.Printf("full  refused %s, no character free", r.RemoteAddr)
		conn.Close(websocket.StatusTryAgainLater, "server full")
		return
	}

	client := s.hub.Add(conn, r.RemoteAddr, s.spawn, character, name)
	// Only a logged-in account carries a persistence key, and it is the account name. A guest leaves this
	// empty, which is how the tick loop knows to skip loading and saving them.
	if loggedIn {
		client.accountKey = accountName
	}
	log.Printf("join  %s (%s the %s) from %s (%d connected)", client.ID, name, character, client.Addr, s.hub.Count())

	defer func() {
		s.hub.Remove(client.ID)
		s.pool.give(character, poolName)
		conn.CloseNow()
		log.Printf("drop  %s (%d connected)", client.ID, s.hub.Count())
	}()

	// Read until the client goes away. Anything that arrives is just noted for now; step 9 starts
	// acting on it. Each read carries the idle deadline: a message ends the read and the next loop makes
	// a fresh timeout, so the clock resets on every message. If the deadline fires first the read fails
	// with a deadline error and we drop them.
	for {
		// A zero or negative idle window turns the kick off entirely, which is what IDLE_TIMEOUT=0 on
		// the box means. Otherwise the read carries the deadline.
		readCtx := r.Context()
		cancel := func() {}
		if s.idle > 0 {
			readCtx, cancel = context.WithTimeout(readCtx, s.idle)
		}
		kind, data, err := conn.Read(readCtx)
		cancel()
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				log.Printf("idle  %s sent nothing for %s, dropping", client.ID, s.idle)
				conn.Close(websocket.StatusPolicyViolation, "idle")
				return
			}
			status := websocket.CloseStatus(err)
			if status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway {
				return // they closed the tab, which is not a problem
			}
			log.Printf("read  %s ended: %v", client.ID, err)
			return
		}

		// Decode the frame. A text frame is JSON and a binary frame is protobuf, which is all Decode needs
		// to pick the right reader. An input goes to the tick loop; a ping is answered here and now, from
		// this goroutine, so the round trip the client measures is not padded by waiting for the next tick.
		text := kind == websocket.MessageText
		var msg pb.ClientMessage
		if err := wire.Decode(&msg, data, text); err != nil {
			log.Printf("bad   %s message: %v", client.ID, err)
			continue
		}
		// Reply in whatever the client just spoke, so flipping encoding on the client needs no handshake.
		if text {
			client.setEncoding(wire.JSON)
		} else {
			client.setEncoding(wire.Protobuf)
		}
		switch body := msg.Body.(type) {
		case *pb.ClientMessage_Input:
			client.offer(pbToInput(body.Input))
		case *pb.ClientMessage_Ping:
			pong := &pb.ServerMessage{Body: &pb.ServerMessage_Pong{Pong: &pb.Pong{
				ClientTime: body.Ping.ClientTime,
				ServerTick: s.tickNum.Load(),
			}}}
			s.sendMsg(r.Context(), client, pong)
		}
	}
}
