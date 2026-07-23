package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
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

	// The world the tick loop simulates in. planet and path are the same math the client and the golden
	// test use; spawn is where a new player appears, the north pole, matching the client's spawn.
	planet  sim.Planet
	path    *sim.Path
	spawn   sim.Vec3
	tickNum uint32 // counts up forever, stamped on every snapshot; only the tick loop touches it

	// Who has been welcomed and is in play. The tick loop diffs this against the live connections each
	// tick to find joins and leaves, so it stays the single writer to every socket. Only the tick loop
	// touches it, so it needs no lock.
	welcomed map[string]bool
}

func main() {
	addr := env("ADDR", defaultAddr)
	origins := strings.Split(env("ALLOWED_ORIGINS", defaultOrigins), ",")
	idle := envDuration("IDLE_TIMEOUT", defaultIdle)

	planet := sim.NewPlanet()
	path := sim.NewPath(planet.Radius)
	s := &server{
		hub:      NewHub(),
		origins:  origins,
		idle:     idle,
		planet:   planet,
		path:     &path,
		spawn:    sim.Vec3{X: 0, Y: planet.Radius, Z: 0}, // north pole, where up is +Y
		welcomed: make(map[string]bool),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
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

	client := s.hub.Add(conn, r.RemoteAddr, s.spawn)
	log.Printf("join  %s from %s (%d connected)", client.ID, client.Addr, s.hub.Count())

	defer func() {
		s.hub.Remove(client.ID)
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

		// Decode the frame and, if it is an input, hand it to the tick loop. A text frame is JSON and a
		// binary frame is protobuf, which is all Decode needs to pick the right reader. Anything that is
		// not an input is ignored for now; join and the rest arrive in later steps.
		var msg pb.ClientMessage
		if err := wire.Decode(&msg, data, kind == websocket.MessageText); err != nil {
			log.Printf("bad   %s message: %v", client.ID, err)
			continue
		}
		if in := msg.GetInput(); in != nil {
			client.offer(pbToInput(in))
		}
	}
}
