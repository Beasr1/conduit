package store

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

// Constants (plan 06): named values every expression reads as $const.name.
// Each value, and the one before its last change, is sealed with
// AES-256-GCM under the server's key, the constant's name as associated
// data, so a value moved to another constant's row doesn't open.

var (
	// ErrNoKey means the store was opened without a constants key.
	ErrNoKey = errors.New("constants need CONDUIT_CONSTANTS_KEY")
	// ErrNothingToUndo is an undo on a constant whose value was never
	// changed, or whose change was undone and redone away.
	ErrNothingToUndo = errors.New("it has no previous value")
)

// Constant is a named value, opened.
type Constant struct {
	Name        string
	Secret      bool
	Value       string
	HasPrevious bool
	Provenance  Provenance
	UpdatedAt   time.Time
	CreatedAt   time.Time
}

// sealed is a constant as stored.
type sealed struct {
	Name       string     `db:"name"`
	Secret     bool       `db:"secret"`
	Value      []byte     `db:"value"`
	Previous   []byte     `db:"previous"`
	Provenance Provenance `db:"provenance"`
	UpdatedAt  time.Time  `db:"updated_at"`
	CreatedAt  time.Time  `db:"created_at"`
}

const constantColumns = `name, secret, value, previous, provenance, updated_at, created_at`

func (s *Store) seal(name, value string) ([]byte, error) {
	if s.aead == nil {
		return nil, ErrNoKey
	}
	return s.aead.Seal(nil, nil, []byte(value), []byte(name)), nil //nolint:gosec // G407: NewGCMWithRandomNonce makes a random nonce for each Seal, so none is passed
}

func (s *Store) open(c sealed) (Constant, error) {
	if s.aead == nil {
		return Constant{}, ErrNoKey
	}
	v, err := s.aead.Open(nil, nil, c.Value, []byte(c.Name))
	if err != nil {
		return Constant{}, fmt.Errorf("open constant %s: it was sealed with another key", c.Name)
	}
	return Constant{
		Name: c.Name, Secret: c.Secret, Value: string(v), HasPrevious: c.Previous != nil,
		Provenance: c.Provenance, UpdatedAt: c.UpdatedAt, CreatedAt: c.CreatedAt,
	}, nil
}

// CreateConstant stores a new constant.
func (s *Store) CreateConstant(ctx context.Context, name, value string, secret bool, p Provenance) (Constant, error) {
	v, err := s.seal(name, value)
	if err != nil {
		return Constant{}, fmt.Errorf("create constant %s: %w", name, err)
	}
	c, err := one[sealed](ctx, s.pool, `INSERT INTO constants (name, secret, value, provenance)
		VALUES ($1, $2, $3, $4) RETURNING `+constantColumns, name, secret, v, p)
	if err != nil {
		return Constant{}, fmt.Errorf("create constant %s: %w", name, translate(err))
	}
	return s.open(c)
}

// Constant fetches one constant, opened.
func (s *Store) Constant(ctx context.Context, name string) (Constant, error) {
	c, err := one[sealed](ctx, s.pool, `SELECT `+constantColumns+` FROM constants WHERE name = $1`, name)
	if err != nil {
		return Constant{}, fmt.Errorf("get constant %s: %w", name, translate(err))
	}
	return s.open(c)
}

// ConstantNames is the names of the constants there are, which
// expressions may read, with no value opened.
func (s *Store) ConstantNames(ctx context.Context) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `SELECT name FROM constants`)
	if err != nil {
		return nil, fmt.Errorf("list constants' names: %w", translate(err))
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, fmt.Errorf("list constants' names: %w", translate(err))
	}
	known := make(map[string]bool, len(names))
	for _, n := range names {
		known[n] = true
	}
	return known, nil
}

// Constants lists every constant, opened, by name.
func (s *Store) Constants(ctx context.Context) ([]Constant, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+constantColumns+` FROM constants ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("list constants: %w", translate(err))
	}
	cs, err := pgx.CollectRows(rows, pgx.RowToStructByName[sealed])
	if err != nil {
		return nil, fmt.Errorf("list constants: %w", translate(err))
	}
	out := make([]Constant, len(cs))
	for i, c := range cs {
		if out[i], err = s.open(c); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// SetConstant changes a constant's value, keeping the one before for
// UndoConstant. secret makes a plain constant secret, for good: false
// leaves it as it is. A value equal to the one it has changes nothing, so
// the previous value stays the one to go back to.
func (s *Store) SetConstant(ctx context.Context, name, value string, secret bool, p Provenance) (Constant, error) {
	var out Constant
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		c, err := one[sealed](ctx, tx, `SELECT `+constantColumns+` FROM constants WHERE name = $1 FOR UPDATE`, name)
		if err != nil {
			return err
		}
		now, err := s.open(c)
		if err != nil {
			return err
		}
		if now.Value == value {
			if now.Secret || !secret {
				out = now
				return nil
			}
			// Made secret only: the previous value stays the one to go
			// back to.
			c, err = one[sealed](ctx, tx, `UPDATE constants SET secret = true, provenance = $2, updated_at = now()
				WHERE name = $1 RETURNING `+constantColumns, name, p)
			if err != nil {
				return err
			}
			out, err = s.open(c)
			return err
		}
		v, err := s.seal(name, value)
		if err != nil {
			return err
		}
		c, err = one[sealed](ctx, tx, `UPDATE constants
			SET value = $2, previous = value, secret = secret OR $3, provenance = $4, updated_at = now()
			WHERE name = $1 RETURNING `+constantColumns, name, v, secret, p)
		if err != nil {
			return err
		}
		out, err = s.open(c)
		return err
	})
	if err != nil {
		return Constant{}, fmt.Errorf("set constant %s: %w", name, translate(err))
	}
	return out, nil
}

// UndoConstant puts a constant's previous value back, and keeps the one it
// replaces as the previous, so undoing again puts that back.
func (s *Store) UndoConstant(ctx context.Context, name string, p Provenance) (Constant, error) {
	var out Constant
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		c, err := one[sealed](ctx, tx, `SELECT `+constantColumns+` FROM constants WHERE name = $1 FOR UPDATE`, name)
		if err != nil {
			return err
		}
		if c.Previous == nil {
			return ErrNothingToUndo
		}
		c, err = one[sealed](ctx, tx, `UPDATE constants
			SET value = previous, previous = value, provenance = $2, updated_at = now()
			WHERE name = $1 RETURNING `+constantColumns, name, p)
		if err != nil {
			return err
		}
		out, err = s.open(c)
		return err
	})
	if err != nil {
		return Constant{}, fmt.Errorf("undo constant %s: %w", name, translate(err))
	}
	return out, nil
}

// ConstantReader is a workflow or an upstream that reads a constant: its
// id, its name, and which of its revisions or versions read it, oldest
// first.
type ConstantReader struct {
	ID   string `db:"id"`
	Name string `db:"name"`
	At   []int  `db:"at"`
}

// ConstantInUseError is a delete refused because saved revisions, or
// upstream versions, read the constant, and each can run again.
type ConstantInUseError struct {
	Workflows []ConstantReader
	Upstreams []ConstantReader
}

func (e *ConstantInUseError) Error() string {
	return fmt.Sprintf("%d workflows and %d upstreams read it", len(e.Workflows), len(e.Upstreams))
}

// readPattern matches a definition that reads constant name as
// $const.name, the name ending where the read does. It also matches the
// words inside a string, which only errs towards keeping a constant.
func readPattern(name string) string {
	return `\$const\.` + regexp.QuoteMeta(name) + `([^a-z0-9_]|$)`
}

// The workflows whose revisions read a constant, and the upstreams whose
// versions do: every revision and version, or with latest, only the latest
// of each. $1 is readPattern's.
const (
	workflowReaders = `SELECT w.id::text AS id, w.name, array_agg(r.revision ORDER BY r.revision) AS at
		FROM workflows w JOIN workflow_revisions r ON r.workflow_id = w.id
		WHERE r.definition::text ~ $1 AND (NOT $2 OR r.revision = w.latest_revision)
		GROUP BY w.id, w.name ORDER BY w.name, w.id`
	upstreamReaders = `SELECT u.id::text AS id, u.name, array_agg(v.version ORDER BY v.version) AS at
		FROM upstreams u JOIN upstream_versions v ON v.upstream_id = u.id
		WHERE v.definition::text ~ $1 AND (NOT $2 OR v.version = u.latest_version)
		GROUP BY u.id, u.name ORDER BY u.name, u.id`
)

func readers(ctx context.Context, q querier, sql, name string, latest bool) ([]ConstantReader, error) {
	rows, err := q.Query(ctx, sql, readPattern(name), latest)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByName[ConstantReader])
}

// DeleteConstant deletes a constant, unless a saved revision of a
// workflow, published or not, or a version of an upstream reads it: then
// it's refused with a *ConstantInUseError naming them.
func (s *Store) DeleteConstant(ctx context.Context, name string) error {
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// SHARE lets reads through and holds back every insert, so nothing
		// is saved reading it between the check and the delete.
		if _, err := tx.Exec(ctx, `LOCK TABLE workflow_revisions, upstream_versions IN SHARE MODE`); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT 1 FROM constants WHERE name = $1 FOR UPDATE`, name).Scan(new(int)); err != nil {
			return err
		}
		ws, err := readers(ctx, tx, workflowReaders, name, false)
		if err != nil {
			return err
		}
		us, err := readers(ctx, tx, upstreamReaders, name, false)
		if err != nil {
			return err
		}
		if len(ws) > 0 || len(us) > 0 {
			return &ConstantInUseError{Workflows: ws, Upstreams: us}
		}
		_, err = tx.Exec(ctx, `DELETE FROM constants WHERE name = $1`, name)
		return err
	})
	if err != nil {
		return fmt.Errorf("delete constant %s: %w", name, translate(err))
	}
	return nil
}

// ConstantUsers is what reads a constant now: the workflows whose latest
// revision does, and the upstreams whose latest version does.
type ConstantUsers struct {
	Workflows []ConstantReader
	Upstreams []ConstantReader
}

// ConstantUsers lists what reads constant name now.
func (s *Store) ConstantUsers(ctx context.Context, name string) (ConstantUsers, error) {
	if err := s.pool.QueryRow(ctx, `SELECT 1 FROM constants WHERE name = $1`, name).Scan(new(int)); err != nil {
		return ConstantUsers{}, fmt.Errorf("list the users of constant %s: %w", name, translate(err))
	}
	ws, err := readers(ctx, s.pool, workflowReaders, name, true)
	if err != nil {
		return ConstantUsers{}, fmt.Errorf("list the users of constant %s: %w", name, translate(err))
	}
	us, err := readers(ctx, s.pool, upstreamReaders, name, true)
	if err != nil {
		return ConstantUsers{}, fmt.Errorf("list the users of constant %s: %w", name, translate(err))
	}
	return ConstantUsers{Workflows: ws, Upstreams: us}, nil
}
