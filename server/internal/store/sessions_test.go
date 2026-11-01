package store_test

import (
	"crypto/sha256"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// hashOf is a session id's SHA-256, as the store keeps it.
func hashOf(id string) []byte {
	h := sha256.Sum256([]byte(id))
	return h[:]
}

// minutes counts from a moment: minutes(t0)(20) is t0 plus 20 minutes.
func minutes(t0 time.Time) func(int) time.Time {
	return func(m int) time.Time { return t0.Add(time.Duration(m) * time.Minute) }
}

// A session goes idle 30 minutes after its last use, and each use starts
// that afresh, until it expires, an hour after sign-in here.
func TestSession_IdleAndExpiry(t *testing.T) {
	t.Parallel()
	const idle = 30
	type use struct {
		minute int
		live   bool
	}
	tests := []struct {
		name string
		uses []use
	}{
		{"unused for its idle time", []use{{31, false}}},
		{"a use starts the idle time afresh", []use{{20, true}, {45, true}}},
		{"expired, though used 16 minutes before", []use{{20, true}, {45, true}, {61, false}}},
		{"gone idle, a use doesn't revive it", []use{{31, false}, {32, false}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			at := minutes(time.Now())
			id := hashOf(t.Name())
			if err := db.CreateSession(t.Context(), id, at(0), at(-idle), at(60)); err != nil {
				t.Fatal(err)
			}
			for _, u := range tt.uses {
				live, err := db.TouchSession(t.Context(), id, at(u.minute), at(u.minute-idle))
				if err != nil || live != u.live {
					t.Errorf("at minute %d: live %v, %v; want %v", u.minute, live, err, u.live)
				}
			}
		})
	}
}

func TestSession_Delete(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	at := minutes(time.Now())
	id := hashOf(t.Name())
	if err := db.CreateSession(ctx, id, at(0), at(-30), at(60)); err != nil {
		t.Fatal(err)
	}
	for range 2 { // the second time, it's already gone
		if err := db.DeleteSession(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	if live, err := db.TouchSession(ctx, id, at(1), at(-29)); live || err != nil {
		t.Errorf("a deleted session: live %v, %v", live, err)
	}
	if live, err := db.TouchSession(ctx, hashOf("never made"), at(1), at(-29)); live || err != nil {
		t.Errorf("an unknown session: live %v, %v", live, err)
	}
}

// A sign-in deletes the sessions that have ended, by expiry or idleness,
// and keeps the live ones.
func TestSession_SignInClearsEndedOnes(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	at := minutes(time.Now())
	// Made in this order, none deletes another. expired went unused for less
	// than the idle time, so only its expiry ends it.
	for _, m := range []struct {
		name          string
		used, expires int
	}{{"idle", -35, 600}, {"expired", -20, -5}, {"live", -10, 600}} {
		if err := db.CreateSession(ctx, hashOf(t.Name()+m.name), at(m.used), at(m.used-30), at(m.expires)); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.CreateSession(ctx, hashOf(t.Name()+"new"), at(0), at(-30), at(720)); err != nil {
		t.Fatal(err)
	}

	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	for name, want := range map[string]bool{"expired": false, "idle": false, "live": true, "new": true} {
		var kept bool
		err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM sessions WHERE id_hash = $1)`, hashOf(t.Name()+name)).Scan(&kept)
		if err != nil || kept != want {
			t.Errorf("%s kept: %v, %v; want %v", name, kept, err, want)
		}
	}
}
