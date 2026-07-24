package main

import (
	"log"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// Telegram notifications, the third optional plug-in. A pure listener: it pings a chat when someone joins
// or leaves and never touches gameplay. Pull the file and nothing else changes. It stays off unless both
// TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set, so a dev run and the tests send nothing.

type telegram struct {
	token   string
	chatID  string
	apiBase string // the Telegram API host, a field only so a test can point it at a fake server
	enabled bool
	client  *http.Client
}

func newTelegram(token, chatID string) *telegram {
	return &telegram{
		token:   token,
		chatID:  chatID,
		apiBase: "https://api.telegram.org",
		enabled: token != "" && chatID != "",
		client:  &http.Client{Timeout: 5 * time.Second},
	}
}

// notify sends a message without blocking the caller. The caller is the tick loop, so a slow or down
// Telegram must never hold up the game: the send goes to its own short-lived goroutine and the tick moves
// on. A disabled or nil notifier is a silent no-op, so callers need no guard of their own.
func (t *telegram) notify(msg string) {
	if t == nil || !t.enabled {
		return
	}
	go t.send(msg)
}

// presence turns the raw join and leave churn into calm notifications. A refresh is a disconnect and an
// immediate reconnect, so notifying on each would spam the chat and risk Telegram's rate limit. So a leave
// is held for a grace period, and a rejoin of the same name within it cancels both the pending leave and
// the new join: the refresh goes silent. Only a leave that outlives the grace, or a join with no recent
// leave, actually fires. Arrivals are still instant; only departures wait to be confirmed real.
//
// Identity is the display name, which is stable for an account and resumed for a guest across a refresh.
// Two different players never hold the same name at once, so a name is a safe key for the short window.
type presence struct {
	mu      sync.Mutex
	pending map[string]int64 // name -> generation of its currently-held leave, absent when none is held
	gen     int64            // ever-increasing, so a superseded leave timer can tell it is stale
	grace   time.Duration
	notify  func(string)
}

func newPresence(grace time.Duration, notify func(string)) *presence {
	return &presence{pending: make(map[string]int64), grace: grace, notify: notify}
}

// joined fires the arrival message, unless a leave for this name is still being held, in which case it was
// a reconnect: cancel the leave and stay silent.
func (p *presence) joined(name, msg string) {
	if p == nil {
		return
	}
	p.mu.Lock()
	if _, held := p.pending[name]; held {
		delete(p.pending, name) // the held leave's timer will see its generation is gone and stay quiet
		p.mu.Unlock()
		return
	}
	p.mu.Unlock()
	p.notify(msg)
}

// left holds the departure message for the grace period. If joined cancels it first, or another leave
// supersedes it, the timer finds its generation no longer current and sends nothing.
func (p *presence) left(name, msg string) {
	if p == nil {
		return
	}
	p.mu.Lock()
	p.gen++
	g := p.gen
	p.pending[name] = g
	p.mu.Unlock()

	time.AfterFunc(p.grace, func() {
		p.mu.Lock()
		if cur, held := p.pending[name]; held && cur == g {
			delete(p.pending, name)
			p.mu.Unlock()
			p.notify(msg)
			return
		}
		p.mu.Unlock()
	})
}

// send posts one message to the Bot API. Failures are logged and dropped, never retried, because a missed
// notification is not worth complicating the game over.
func (t *telegram) send(msg string) {
	resp, err := t.client.PostForm(t.apiBase+"/bot"+t.token+"/sendMessage",
		url.Values{"chat_id": {t.chatID}, "text": {msg}})
	if err != nil {
		log.Printf("telegram send: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("telegram send: status %d", resp.StatusCode)
	}
}
