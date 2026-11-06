package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Caller keys (plan 07): a workflow is served with keys of its own, one per
// caller. The HTTP layer mints a key and shows it once; the store keeps its
// first characters and its SHA-256, never the key. A key is rotated and
// revoked, never deleted.

// ErrKeyNotActive is a rotation of a key rotated or revoked already.
var ErrKeyNotActive = errors.New("the key was rotated or revoked already")

// CallerKey is a key a workflow is served with.
type CallerKey struct {
	ID         string     `db:"id"`
	WorkflowID string     `db:"workflow_id"`
	Name       string     `db:"name"` // who calls with it
	Prefix     string     `db:"prefix"`
	Status     string     `db:"status"`       // active, expiring, expired or revoked
	ExpiresAt  *time.Time `db:"expires_at"`   // set once it's rotated
	RevokedAt  *time.Time `db:"revoked_at"`   // set once it's revoked
	LastUsedAt *time.Time `db:"last_used_at"` // when its latest run started; nil if none has
	Provenance Provenance `db:"provenance"`
	CreatedAt  time.Time  `db:"created_at"`
}

// NewKey is a key just minted, as the store keeps it.
type NewKey struct {
	Prefix string // its first characters
	Hash   []byte // its SHA-256
}

// keyColumns says what state a key is in as of now(), a transaction's
// start, and when it was last used.
const keyColumns = `id::text AS id, workflow_id::text AS workflow_id, name, prefix,
	CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at IS NULL THEN 'active'
		WHEN expires_at > now() THEN 'expiring' ELSE 'expired' END AS status,
	expires_at, revoked_at, (SELECT max(started_at) FROM runs WHERE runs.caller_key = caller_keys.id) AS last_used_at,
	provenance, created_at`

// CreateKey stores a new active key of a workflow, named for its caller.
// ErrConflict: an active key of the workflow has the name.
func (s *Store) CreateKey(ctx context.Context, workflowID, name string, k NewKey, p Provenance) (CallerKey, error) {
	key, err := one[CallerKey](ctx, s.pool, `INSERT INTO caller_keys (workflow_id, name, prefix, hash, provenance)
		VALUES ($1::uuid, $2, $3, $4, $5) RETURNING `+keyColumns, workflowID, name, k.Prefix, k.Hash, p)
	if err != nil {
		return CallerKey{}, fmt.Errorf("make a key of %s: %w", workflowID, translate(err))
	}
	return key, nil
}

// Keys lists every key a workflow has had, newest first. Ids are UUIDv7,
// so their order is their age.
func (s *Store) Keys(ctx context.Context, workflowID string) ([]CallerKey, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+keyColumns+` FROM caller_keys WHERE workflow_id = $1::uuid ORDER BY id DESC`, workflowID)
	if err != nil {
		return nil, fmt.Errorf("list the keys of %s: %w", workflowID, translate(err))
	}
	keys, err := pgx.CollectRows(rows, pgx.RowToStructByName[CallerKey])
	if err != nil {
		return nil, fmt.Errorf("list the keys of %s: %w", workflowID, translate(err))
	}
	return keys, nil
}

// RotateKey gives an active key's caller a new key with its name, k, and the
// old key an expiry grace from now: until then both work. It returns the new
// key and the old. ErrNotFound: the workflow has no such key;
// ErrKeyNotActive: it was rotated or revoked already.
func (s *Store) RotateKey(ctx context.Context, workflowID, id string, grace time.Duration, k NewKey, p Provenance) (made, old CallerKey, err error) {
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// Locked, so of two rotations at once the second finds it rotated.
		var active bool
		if err := tx.QueryRow(ctx, `SELECT expires_at IS NULL AND revoked_at IS NULL FROM caller_keys
			WHERE id = $1::uuid AND workflow_id = $2::uuid FOR UPDATE`, id, workflowID).Scan(&active); err != nil {
			return err
		}
		if !active {
			return ErrKeyNotActive
		}
		// The old key first, so its name is free for the new one.
		var err error
		old, err = one[CallerKey](ctx, tx, `UPDATE caller_keys SET expires_at = now() + make_interval(secs => $2)
			WHERE id = $1::uuid RETURNING `+keyColumns, id, grace.Seconds())
		if err != nil {
			return err
		}
		made, err = one[CallerKey](ctx, tx, `INSERT INTO caller_keys (workflow_id, name, prefix, hash, provenance)
			VALUES ($1::uuid, $2, $3, $4, $5) RETURNING `+keyColumns, workflowID, old.Name, k.Prefix, k.Hash, p)
		return err
	})
	if err != nil {
		return CallerKey{}, CallerKey{}, fmt.Errorf("rotate key %s of %s: %w", id, workflowID, translate(err))
	}
	return made, old, nil
}

// RevokeKey stops a key of a workflow at once. One revoked already, or past
// its expiry, stays as it is. ErrNotFound: the workflow has no such key.
func (s *Store) RevokeKey(ctx context.Context, workflowID, id string) (CallerKey, error) {
	key, err := one[CallerKey](ctx, s.pool, `UPDATE caller_keys
		SET revoked_at = COALESCE(revoked_at, CASE WHEN expires_at IS NULL OR expires_at > now() THEN now() END)
		WHERE id = $1::uuid AND workflow_id = $2::uuid RETURNING `+keyColumns, id, workflowID)
	if err != nil {
		return CallerKey{}, fmt.Errorf("revoke key %s of %s: %w", id, workflowID, translate(err))
	}
	return key, nil
}

// ServingKey is the id of the key whose SHA-256 is hash, if it's a key of
// the workflow at slug and works: not revoked, and not past its expiry.
// ErrNotFound otherwise, for any of those reasons alike.
func (s *Store) ServingKey(ctx context.Context, slug string, hash []byte) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `SELECT k.id::text FROM caller_keys k JOIN workflows w ON w.id = k.workflow_id
		WHERE k.hash = $1 AND w.slug = $2 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())`,
		hash, slug).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("find a key of %s: %w", slug, translate(err))
	}
	return id, nil
}
