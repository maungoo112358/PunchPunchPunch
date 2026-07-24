package main

import (
	"database/sql"
	"sync"

	"punchpunchpunch/server/sim"

	_ "modernc.org/sqlite" // pure-Go SQLite driver, registered under the name "sqlite"
)

// Stats persistence, the second optional plug-in. Pull it and the server runs on an in-memory map that
// forgets everyone on exit; wire the SQLite store and a logged-in account's data survives a restart or a
// deploy. The game only ever asks two things through one seam, "load this player" and "save this player",
// so swapping SQLite for Postgres later is a second implementation of Store and nothing in the game loop
// changes.
//
// Only logged-in accounts are persisted. A guest's identity lives in their browser tab and is gone when
// they close it, so there is no stable key to save them under. The key is the account's display name,
// which is unique across our seeded accounts; a bigger system would key on an account id instead.

// Stats is the handful of things worth remembering about an account between sessions. Position and Forward
// are where they were standing when they left, so they resume there. Visits and PlaySeconds are vanity.
type Stats struct {
	Visits      int
	PlaySeconds int
	Pos         sim.Vec3
	Fwd         sim.Vec3
}

// Store is the load/save seam. Load reports false when the key has never been seen, which is a first
// visit. Both are called only from the tick loop, so implementations need no locking for that caller, but
// the in-memory one keeps a lock anyway so it is safe if that ever changes.
type Store interface {
	Load(key string) (Stats, bool)
	Save(key string, s Stats) error
	Close() error
}

// memStore is the default: a map that lives only as long as the process. It is the "plug-in removed"
// behaviour, and what the tests use, so no file is touched unless STATS_DB names one.
type memStore struct {
	mu sync.Mutex
	m  map[string]Stats
}

func newMemStore() *memStore { return &memStore{m: make(map[string]Stats)} }

func (s *memStore) Load(key string) (Stats, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.m[key]
	return v, ok
}

func (s *memStore) Save(key string, st Stats) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[key] = st
	return nil
}

func (s *memStore) Close() error { return nil }

// sqliteStore is the persistent one, a single file on disk read through the pure-Go driver so the
// CGO_ENABLED=0 cross-compile in the deploy still builds. The file lives at a fixed path on the box, not
// beside the binary, so installing a new build never deletes it.
type sqliteStore struct {
	db *sql.DB
}

func newSQLiteStore(path string) (*sqliteStore, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// One row per account. The nine columns are the flat Stats: two counters and two vectors. IF NOT
	// EXISTS so the same start-up code makes the table the first time and finds it every time after.
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS stats (
		key          TEXT PRIMARY KEY,
		visits       INTEGER NOT NULL,
		play_seconds INTEGER NOT NULL,
		px REAL NOT NULL, py REAL NOT NULL, pz REAL NOT NULL,
		fx REAL NOT NULL, fy REAL NOT NULL, fz REAL NOT NULL
	)`); err != nil {
		db.Close()
		return nil, err
	}
	return &sqliteStore{db: db}, nil
}

func (s *sqliteStore) Load(key string) (Stats, bool) {
	var st Stats
	row := s.db.QueryRow(
		`SELECT visits, play_seconds, px, py, pz, fx, fy, fz FROM stats WHERE key = ?`, key)
	if err := row.Scan(
		&st.Visits, &st.PlaySeconds,
		&st.Pos.X, &st.Pos.Y, &st.Pos.Z,
		&st.Fwd.X, &st.Fwd.Y, &st.Fwd.Z,
	); err != nil {
		return Stats{}, false // sql.ErrNoRows for a first visit, or a real error we treat the same way
	}
	return st, true
}

func (s *sqliteStore) Save(key string, st Stats) error {
	// Upsert: insert the row, or overwrite it if the key is already there. So the first save creates the
	// account's row and every save after updates it in place.
	_, err := s.db.Exec(`INSERT INTO stats (key, visits, play_seconds, px, py, pz, fx, fy, fz)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET
			visits=excluded.visits, play_seconds=excluded.play_seconds,
			px=excluded.px, py=excluded.py, pz=excluded.pz,
			fx=excluded.fx, fy=excluded.fy, fz=excluded.fz`,
		key, st.Visits, st.PlaySeconds,
		st.Pos.X, st.Pos.Y, st.Pos.Z,
		st.Fwd.X, st.Fwd.Y, st.Fwd.Z)
	return err
}

func (s *sqliteStore) Close() error { return s.db.Close() }
