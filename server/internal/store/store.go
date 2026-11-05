// Package store keeps conduit's state in Postgres: workflows, their
// revisions, runs, and the web app's sessions. Queries are plain SQL through pgx. Driver errors are translated
// here, so callers see ErrNotFound, ErrConflict and ErrRevisionMismatch,
// never a pgx type.
package store

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound = errors.New("not found")
	// ErrConflict is a unique value already taken, such as a slug.
	ErrConflict = errors.New("already exists")
	// ErrRevisionMismatch means a save named a revision that's no longer
	// the latest: someone else saved first.
	ErrRevisionMismatch = errors.New("the workflow has a newer revision")
	// ErrVersionMismatch is ErrRevisionMismatch for an upstream: a save named
	// a version that's no longer its latest (plan 07).
	ErrVersionMismatch = errors.New("the upstream has a newer version")
)

// Store is the database. It's safe for concurrent use.
type Store struct {
	pool *pgxpool.Pool
	// seals constants' values (plan 06); nil without a key.
	aead cipher.AEAD
}

// Open connects with the session settings the server runs under. A query
// that runs longer than 5 s, or a transaction left idle for 10 s, fails
// rather than holding locks. Migrate connects without them. constantsKey,
// 32 bytes, seals constants' values; without one, constants are refused
// with ErrNoKey.
func Open(ctx context.Context, databaseURL string, constantsKey []byte) (*Store, error) {
	var aead cipher.AEAD
	if constantsKey != nil {
		if len(constantsKey) != 32 {
			return nil, errors.New("open the database: the constants key isn't 32 bytes")
		}
		block, err := aes.NewCipher(constantsKey)
		if err != nil {
			return nil, fmt.Errorf("open the database: %w", err)
		}
		// A random nonce for each value, prepended to it.
		if aead, err = cipher.NewGCMWithRandomNonce(block); err != nil {
			return nil, fmt.Errorf("open the database: %w", err)
		}
	}
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		// pgx's own message redacts passwords only "best effort".
		return nil, errors.New("open the database: the connection settings can't be parsed")
	}
	params := cfg.ConnConfig.RuntimeParams
	params["application_name"] = "conduit"
	params["statement_timeout"] = "5000"
	params["idle_in_transaction_session_timeout"] = "10000"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open the database: %w", err)
	}
	return &Store{pool: pool, aead: aead}, nil
}

// Close waits for queries in progress and closes every connection.
func (s *Store) Close() { s.pool.Close() }

// Ping checks the database answers.
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// translate turns driver errors into the package's own.
func translate(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		switch pe.Code {
		case "23505": // unique_violation
			return fmt.Errorf("%w (%s)", ErrConflict, pe.ConstraintName)
		case "22P02": // invalid_text_representation: an id that isn't a uuid names nothing
			return ErrNotFound
		}
	}
	return err
}
