package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

// Off unless configured, and off must be truly silent: no panic, no request. Both a zero-config notifier
// and a nil one are exercised, because the tick loop calls notify on whatever is on the server, guard-free.
func TestTelegramDisabledIsNoop(t *testing.T) {
	tg := newTelegram("", "")
	if tg.enabled {
		t.Fatal("no token or chat id should be disabled")
	}
	tg.notify("nobody should get this") // must not panic or send

	var nilTg *telegram
	nilTg.notify("still safe") // a nil notifier is a no-op too
}

// An enabled notifier posts to the Bot API with the chat id and the exact message. A fake server stands in
// for Telegram so the test makes a real HTTP round trip without leaving the machine.
func TestTelegramSendsFormattedMessage(t *testing.T) {
	got := make(chan url.Values, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		got <- r.Form
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	tg := newTelegram("TESTTOKEN", "999")
	tg.apiBase = srv.URL
	tg.notify("Gandalf the wizard joined — 3 online")

	form := <-got
	if form.Get("chat_id") != "999" {
		t.Fatalf("chat_id = %q, want 999", form.Get("chat_id"))
	}
	if want := "Gandalf the wizard joined — 3 online"; form.Get("text") != want {
		t.Fatalf("text = %q, want %q", form.Get("text"), want)
	}
}

// The whole point of presence: a fresh arrival and a real departure both notify, but a refresh (a leave
// immediately followed by a rejoin of the same name) cancels out and stays silent.
func TestPresenceCoalescesRefresh(t *testing.T) {
	got := make(chan string, 8)
	p := newPresence(50*time.Millisecond, func(m string) { got <- m })

	// A genuine arrival notifies right away.
	p.joined("Gandalf", "joined")
	if m := <-got; m != "joined" {
		t.Fatalf("arrival should notify, got %q", m)
	}

	// A refresh: leave, then rejoin within the grace. Nothing should fire, even after the grace passes.
	p.left("Gandalf", "left")
	p.joined("Gandalf", "joined-again")
	select {
	case m := <-got:
		t.Fatalf("a refresh should be silent, got %q", m)
	case <-time.After(120 * time.Millisecond):
	}

	// A real departure: no rejoin, so it notifies once the grace elapses.
	p.left("Gandalf", "left-for-real")
	select {
	case m := <-got:
		if m != "left-for-real" {
			t.Fatalf("real leave should notify, got %q", m)
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("a real leave should notify after the grace")
	}
}
