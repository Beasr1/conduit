package store

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
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
	ArchivedAt  *time.Time // nil unless it's archived (plan 15)
	ArchivedBy  *Provenance
}

// sealed is a constant as stored.
type sealed struct {
	Name       string      `db:"name"`
	Secret     bool        `db:"secret"`
	Value      []byte      `db:"value"`
	Previous   []byte      `db:"previous"`
	Provenance Provenance  `db:"provenance"`
	UpdatedAt  time.Time   `db:"updated_at"`
	CreatedAt  time.Time   `db:"created_at"`
	ArchivedAt *time.Time  `db:"archived_at"`
	ArchivedBy *Provenance `db:"archived_by"`
}

const constantColumns = `name, secret, value, previous, provenance, updated_at, created_at, archived_at, archived_by`

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
		ArchivedAt: c.ArchivedAt, ArchivedBy: c.ArchivedBy,
	}, nil
}

// CreateConstant stores a new constant. A name in use is ErrConflict, and
// one only an archived constant has, ErrArchivedName.
func (s *Store) CreateConstant(ctx context.Context, name, value string, secret bool, p Provenance) (Constant, error) {
	v, err := s.seal(name, value)
	if err != nil {
		return Constant{}, fmt.Errorf("create constant %s: %w", name, err)
	}
	if err := archivedName(ctx, s.pool, `SELECT 1 FROM constants WHERE name = $1 AND archived_at IS NOT NULL`, name); err != nil {
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

// ConstantNames is the constants there are, by name, with no value opened:
// true for one expressions may read, and false for one archived (plan 15).
func (s *Store) ConstantNames(ctx context.Context) (map[string]bool, error) {
	return constantNames(ctx, s.pool)
}

func constantNames(ctx context.Context, q querier) (map[string]bool, error) {
	rows, err := q.Query(ctx, `SELECT name, archived_at IS NULL FROM constants`)
	if err != nil {
		return nil, fmt.Errorf("list constants' names: %w", translate(err))
	}
	known := map[string]bool{}
	var name string
	var live bool
	if _, err := pgx.ForEachRow(rows, []any{&name, &live}, func() error {
		known[name] = live
		return nil
	}); err != nil {
		return nil, fmt.Errorf("list constants' names: %w", translate(err))
	}
	return known, nil
}

// Constants lists every constant, opened, by name: archived ones too, as a
// run masks what it meets of a secret one (plan 15).
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
// the previous value stays the one to go back to. An archived constant is
// ErrArchived.
func (s *Store) SetConstant(ctx context.Context, name, value string, secret bool, p Provenance) (Constant, error) {
	var out Constant
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		c, err := one[sealed](ctx, tx, `SELECT `+constantColumns+` FROM constants WHERE name = $1 FOR UPDATE`, name)
		if err != nil {
			return err
		}
		if c.ArchivedAt != nil {
			return ErrArchived
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
// replaces as the previous, so undoing again puts that back. An archived
// constant is ErrArchived.
func (s *Store) UndoConstant(ctx context.Context, name string, p Provenance) (Constant, error) {
	var out Constant
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		c, err := one[sealed](ctx, tx, `SELECT `+constantColumns+` FROM constants WHERE name = $1 FOR UPDATE`, name)
		if err != nil {
			return err
		}
		if c.ArchivedAt != nil {
			return ErrArchived
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

// readPattern matches a definition that reads constant name as
// $const.name, the name ending where the read does. It also matches the
// words inside a string, which only errs towards keeping a constant.
func readPattern(name string) string {
	return `\$const\.` + regexp.QuoteMeta(name) + `([^a-z0-9_]|$)`
}

// aRead finds what readPattern looks for, whatever the name.
var aRead = regexp.MustCompile(`\$const\.([a-z][a-z0-9_]*)`)

// constantsIn is the constants definition def reads, each once, by name.
func constantsIn(def []byte) []string {
	var names []string
	for _, m := range aRead.FindAllSubmatch(def, -1) {
		names = append(names, string(m[1]))
	}
	slices.Sort(names)
	return slices.Compact(names)
}

// ConstantUsers is what reads a constant now, what ArchiveConstant is
// refused for: the latest and published revisions of workflows not archived
// that do, directly or through what they pin, and the latest versions of
// upstreams not archived.
type ConstantUsers struct {
	Workflows []LiveUse
	Upstreams []LiveUse
}

// ConstantUsers lists what reads constant name now, each by name.
func (s *Store) ConstantUsers(ctx context.Context, name string) (ConstantUsers, error) {
	if err := s.pool.QueryRow(ctx, `SELECT 1 FROM constants WHERE name = $1`, name).Scan(new(int)); err != nil {
		return ConstantUsers{}, fmt.Errorf("list the users of constant %s: %w", name, translate(err))
	}
	users, err := readersOf(ctx, s.pool, name)
	if err != nil {
		return ConstantUsers{}, fmt.Errorf("list the users of constant %s: %w", name, translate(err))
	}
	return users, nil
}

func readersOf(ctx context.Context, q querier, name string) (ConstantUsers, error) {
	ws, err := liveUses(ctx, q, workflowReaders, readPattern(name))
	if err != nil {
		return ConstantUsers{}, err
	}
	us, err := liveUses(ctx, q, upstreamReaders, readPattern(name))
	if err != nil {
		return ConstantUsers{}, err
	}
	return ConstantUsers{Workflows: ws, Upstreams: us}, nil
}
