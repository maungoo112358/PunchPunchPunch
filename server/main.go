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
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

type server struct {
	hub     *Hub
	origins []string
}

func main() {
	addr := env("ADDR", defaultAddr)
	origins := strings.Split(env("ALLOWED_ORIGINS", defaultOrigins), ",")

	s := &server{hub: NewHub(), origins: origins}

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

	go func() {
		log.Printf("listening on %s, accepting origins %v", addr, origins)
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

	client := s.hub.Add(conn, r.RemoteAddr)
	log.Printf("join  %s from %s (%d connected)", client.ID, client.Addr, s.hub.Count())

	defer func() {
		s.hub.Remove(client.ID)
		conn.CloseNow()
		log.Printf("drop  %s (%d connected)", client.ID, s.hub.Count())
	}()

	// Read until the client goes away. There is no protocol yet, so anything that arrives is just
	// noted. Step 7 defines the messages and step 9 starts acting on them.
	for {
		kind, data, err := conn.Read(r.Context())
		if err != nil {
			status := websocket.CloseStatus(err)
			if status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway {
				return // they closed the tab, which is not a problem
			}
			log.Printf("read  %s ended: %v", client.ID, err)
			return
		}
		log.Printf("recv  %s %s, %d bytes", client.ID, kind, len(data))
	}
}
