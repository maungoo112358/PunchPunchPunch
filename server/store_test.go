package main

import (
	"path/filepath"
	"testing"

	"punchpunchpunch/server/sim"
)

// The store's contract is small: an unknown key loads as "not found", a saved key loads back exactly, and
// saving the same key again overwrites rather than duplicates. Both the memory and SQLite stores must
// behave the same, so the same checks run against each. The SQLite pass also proves the pure-Go driver
// opens a file and round-trips through real SQL, since that dependency is the whole reason for this step.

func runStoreContract(t *testing.T, s Store) {
	t.Helper()

	if _, ok := s.Load("nobody"); ok {
		t.Fatal("an unknown key should load as not found")
	}

	want := Stats{
		Visits:      3,
		PlaySeconds: 142,
		Pos:         sim.Vec3{X: 1.5, Y: -2.25, Z: 36},
		Fwd:         sim.Vec3{X: 0, Y: 0, Z: 1},
	}
	if err := s.Save("gandalf", want); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, ok := s.Load("gandalf")
	if !ok {
		t.Fatal("a saved key should load back")
	}
	if got != want {
		t.Fatalf("loaded %+v, want %+v", got, want)
	}

	// Saving again with new numbers overwrites the one row rather than adding a second.
	want.Visits = 4
	want.PlaySeconds = 200
	if err := s.Save("gandalf", want); err != nil {
		t.Fatalf("second save: %v", err)
	}
	if got, _ := s.Load("gandalf"); got != want {
		t.Fatalf("after overwrite loaded %+v, want %+v", got, want)
	}
}

func TestMemStore(t *testing.T) {
	s := newMemStore()
	defer s.Close()
	runStoreContract(t, s)
}

func TestSQLiteStore(t *testing.T) {
	s, err := newSQLiteStore(filepath.Join(t.TempDir(), "stats.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	runStoreContract(t, s)
}

// A SQLite store survives being closed and reopened on the same file, which is the whole point: a server
// restart or a deploy must not forget anyone.
func TestSQLitePersistsAcrossReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stats.db")

	s1, err := newSQLiteStore(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	want := Stats{Visits: 7, PlaySeconds: 500, Pos: sim.Vec3{X: 9, Y: 9, Z: 9}, Fwd: sim.Vec3{Z: 1}}
	if err := s1.Save("azathoth", want); err != nil {
		t.Fatalf("save: %v", err)
	}
	s1.Close()

	s2, err := newSQLiteStore(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	if got, ok := s2.Load("azathoth"); !ok || got != want {
		t.Fatalf("after reopen loaded %+v ok=%v, want %+v true", got, ok, want)
	}
}
