package main

import (
	"strings"
	"testing"
)

// The token is the trust boundary of the whole login plug-in: a socket carrying one is believed. So the
// forge cases matter as much as the happy path. A wrong secret, a tampered name or an expired stamp must
// all fail, or a player could name themselves anything.

func TestTokenRoundTrips(t *testing.T) {
	secret := []byte("test-secret")
	name, ok := verifyToken(makeToken("Gandalf", secret), secret)
	if !ok || name != "Gandalf" {
		t.Fatalf("round trip gave %q ok=%v, want Gandalf true", name, ok)
	}
}

func TestTokenRejectsWrongSecret(t *testing.T) {
	token := makeToken("Gandalf", []byte("real-secret"))
	if _, ok := verifyToken(token, []byte("other-secret")); ok {
		t.Fatal("a token signed with another secret verified, that is a forge")
	}
}

func TestTokenRejectsTamper(t *testing.T) {
	secret := []byte("test-secret")
	token := makeToken("Gandalf", secret)
	// Flip the last character of the payload so the name no longer matches the signature.
	dot := strings.IndexByte(token, '.')
	tampered := token[:dot-1] + "X" + token[dot:]
	if _, ok := verifyToken(tampered, secret); ok {
		t.Fatal("a tampered payload verified")
	}
}

func TestTokenRejectsGarbage(t *testing.T) {
	secret := []byte("test-secret")
	for _, junk := range []string{"", "no-dot", "not.base64!!", "."} {
		if _, ok := verifyToken(junk, secret); ok {
			t.Fatalf("garbage token %q verified", junk)
		}
	}
}

func TestTokenExpires(t *testing.T) {
	secret := []byte("test-secret")
	// A properly signed payload whose expiry is unix second 1, back in 1970 and long past. It passes the
	// signature check and fails only on the clock, which is the path we want to exercise.
	payload := []byte("Gandalf|1")
	expired := b64(payload) + "." + b64(sign(payload, secret))
	if _, ok := verifyToken(expired, secret); ok {
		t.Fatal("an expired token verified")
	}
}

func TestCheckLogin(t *testing.T) {
	if name, ok := checkLogin("wizard", "hunter2"); !ok || name != "Gandalf" {
		t.Fatalf("wizard/hunter2 gave %q ok=%v, want Gandalf true", name, ok)
	}
	if _, ok := checkLogin("wizard", "wrong"); ok {
		t.Fatal("wrong password accepted")
	}
	if _, ok := checkLogin("nobody", "hunter2"); ok {
		t.Fatal("unknown user accepted")
	}
}
