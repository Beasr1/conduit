package store

import (
	"context"
	"fmt"
	"time"
)

// The web app's sessions. Each is known by its id's SHA-256, never the id
// itself, and the caller passes in the times: now, and idleSince, before
// which a session last used has gone idle.

// CreateSession records a session, used at now, that ends at expires. It
// first deletes the sessions that ended by now, by their expiry or by going
// idle, so the table holds only live ones and those since gone.
func (s *Store) CreateSession(ctx context.Context, idHash []byte, now, idleSince, expires time.Time) error {
	// A data-modifying WITH runs to completion though nothing reads it.
	_, err := s.pool.Exec(ctx, `WITH ended AS (DELETE FROM sessions WHERE expires_at <= $2 OR seen_at <= $3)
		INSERT INTO sessions (id_hash, seen_at, expires_at) VALUES ($1, $2, $4)`, idHash, now, idleSince, expires)
	if err != nil {
		return fmt.Errorf("create a session: %w", translate(err))
	}
	return nil
}

// TouchSession reports whether a session is live at now: recorded, used
// since idleSince, and not past its expiry. A live one is marked used at
// now, which starts its idle time afresh.
func (s *Store) TouchSession(ctx context.Context, idHash []byte, now, idleSince time.Time) (bool, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE sessions SET seen_at = $2
		WHERE id_hash = $1 AND seen_at > $3 AND expires_at > $2`, idHash, now, idleSince)
	if err != nil {
		return false, fmt.Errorf("check a session: %w", translate(err))
	}
	return tag.RowsAffected() == 1, nil
}

// DeleteSession ends a session. One already gone is no error.
func (s *Store) DeleteSession(ctx context.Context, idHash []byte) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE id_hash = $1`, idHash); err != nil {
		return fmt.Errorf("delete a session: %w", translate(err))
	}
	return nil
}
