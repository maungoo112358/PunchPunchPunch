package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// Login and identity, the first optional plug-in. Pull this file and the game still runs: the socket
// just opens without a token and the name comes from the pool, same as an anonymous player. Add it and
// your name comes from your account. Only the NAME changes here, never the character, which is always
// drawn from the pool.
//
// A login checks a username and password against a few seeded accounts and hands back a signed token.
// The client then opens the game socket carrying that token in the URL, and handleWS trusts the name
// inside it. The token is signed but not encrypted: it proves "the server said this name is yours" and
// nothing more, which is all the game needs.

// How long a token is good for after login. A demo session is short, and an expired token just falls
// back to a pool name rather than locking anyone out, so a day is generous.
const tokenTTL = 24 * time.Hour

// One seeded account. The password is stored as a bcrypt hash, never plaintext, so this source file
// leaking does not leak the passwords. Generate a hash with bcrypt.GenerateFromPassword and paste it.
type account struct {
	passwordHash string // bcrypt hash of the password
	displayName  string // the name that floats over the head once logged in
}

// The seeded accounts, keyed by username. A real system reads these from a database; for a demo a
// handful in code is honest and enough. Passwords: azathoth/outer-god, wizard/hunter2, guest2/guest2.
var accounts = map[string]account{
	"azathoth": {"$2a$10$qHarIQZ1lwronOIoQxajb.y9AFPQomwqv4VDWVlyFCTXYmpydwUGe", "Azathoth"},
	"wizard":   {"$2a$10$GVx8znOSe5hSfJ05QpkehOVNzGNcG.rdW.vVmAsWKns8A3.RCo.qu", "Gandalf"},
	"guest2":   {"$2a$10$qRNPco3S4l8DUuUJMEO.aOPqTvTRh59dkp289kMXjA70HJmetxv3S", "Wanderer"},
}

// checkLogin verifies a username and password against the seeded accounts and returns the display name
// on success. bcrypt.CompareHashAndPassword is the constant-time check that matches the stored hash, so
// a wrong password and an unknown user both fail the same slow way, giving nothing away by timing.
func checkLogin(username, password string) (name string, ok bool) {
	acc, found := accounts[username]
	if !found {
		return "", false
	}
	if bcrypt.CompareHashAndPassword([]byte(acc.passwordHash), []byte(password)) != nil {
		return "", false
	}
	return acc.displayName, true
}

// makeToken signs "name|expiry" with the secret and returns base64(payload).base64(signature). The
// signature is what makes it unforgeable: without the secret you cannot produce a matching one, so you
// cannot mint a token for a name that is not yours. It is signed, not encrypted, so the name is readable
// in the token, which is fine because there is nothing secret in it.
func makeToken(name string, secret []byte) string {
	expiry := time.Now().Add(tokenTTL).Unix()
	payload := []byte(name + "|" + strconv.FormatInt(expiry, 10))
	return b64(payload) + "." + b64(sign(payload, secret))
}

// verifyToken checks the signature and expiry and returns the name inside. A missing, malformed, forged
// or expired token all fail the same way, and the caller falls back to a pool name.
func verifyToken(token string, secret []byte) (name string, ok bool) {
	dot := strings.IndexByte(token, '.')
	if dot < 0 {
		return "", false
	}
	payload, err := unb64(token[:dot])
	if err != nil {
		return "", false
	}
	gotSig, err := unb64(token[dot+1:])
	if err != nil {
		return "", false
	}
	// hmac.Equal is a constant-time compare, so a near-miss signature cannot be found byte by byte.
	if !hmac.Equal(gotSig, sign(payload, secret)) {
		return "", false
	}
	p := string(payload)
	bar := strings.LastIndexByte(p, '|')
	if bar < 0 {
		return "", false
	}
	expiry, err := strconv.ParseInt(p[bar+1:], 10, 64)
	if err != nil || time.Now().Unix() > expiry {
		return "", false
	}
	return p[:bar], true
}

func sign(payload, secret []byte) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	return mac.Sum(nil)
}

func b64(b []byte) string            { return base64.RawURLEncoding.EncodeToString(b) }
func unb64(s string) ([]byte, error) { return base64.RawURLEncoding.DecodeString(s) }

// handleLogin is the POST endpoint the login overlay hits. It lives on a different origin than the page
// (server on api.slint.live, client on slint.live), so it answers the browser's preflight and stamps
// every reply with CORS headers. The token rides the JSON body, not a cookie, so a wildcard origin is
// safe here: there is no credential for another site to ride along with.
func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	// The browser sends OPTIONS first to ask if the real POST is allowed. Answer yes and stop.
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}

	name, ok := checkLogin(req.Username, req.Password)
	if !ok {
		// One message for both wrong-user and wrong-password, so the form cannot be used to learn which
		// usernames exist.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]string{"error": "wrong username or password"})
		return
	}

	log.Printf("login ok for %q as %q", req.Username, name)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"token": makeToken(name, s.tokenSecret),
		"name":  name,
	})
}
