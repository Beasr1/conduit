package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Workflow is a workflow's identity and where its revisions stand.
type Workflow struct {
	ID                string    `db:"id"`
	Slug              string    `db:"slug"`
	Name              string    `db:"name"`
	LatestRevision    int       `db:"latest_revision"`
	PublishedRevision *int      `db:"published_revision"` // nil until published
	CreatedAt         time.Time `db:"created_at"`
}

// Revision is one saved definition. It never changes once written.
type Revision struct {
	WorkflowID string          `db:"workflow_id"`
	Revision   int             `db:"revision"`
	Definition json.RawMessage `db:"definition"` // empty in lists
	Provenance Provenance      `db:"provenance"`
	CreatedAt  time.Time       `db:"created_at"`
}

// Provenance says who saved a revision, and with what. Plan 08 adds the
// model and the spec an agent drafted from.
type Provenance struct {
	Actor  string `json:"actor"`
	Client string `json:"client,omitempty"`
}

const (
	workflowColumns = `id::text AS id, slug, name, latest_revision, published_revision, created_at`
	revisionColumns = `workflow_id::text AS workflow_id, revision, definition, provenance, created_at`
)

// CreateWorkflow stores a new workflow with def as revision 1.
func (s *Store) CreateWorkflow(ctx context.Context, slug, name string, def json.RawMessage, p Provenance) (Workflow, Revision, error) {
	var w Workflow
	var r Revision
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var err error
		w, err = one[Workflow](ctx, tx, `INSERT INTO workflows (slug, name, latest_revision) VALUES ($1, $2, 1)
			RETURNING `+workflowColumns, slug, name)
		if err != nil {
			return err
		}
		r, err = one[Revision](ctx, tx, `INSERT INTO workflow_revisions (workflow_id, revision, definition, provenance)
			VALUES ($1::uuid, 1, $2, $3) RETURNING `+revisionColumns, w.ID, def, p)
		return err
	})
	if err != nil {
		return Workflow{}, Revision{}, fmt.Errorf("create workflow: %w", translate(err))
	}
	return w, r, nil
}

// Workflow fetches one workflow.
func (s *Store) Workflow(ctx context.Context, id string) (Workflow, error) {
	w, err := one[Workflow](ctx, s.pool, `SELECT `+workflowColumns+` FROM workflows WHERE id = $1::uuid`, id)
	if err != nil {
		return Workflow{}, fmt.Errorf("get workflow %s: %w", id, translate(err))
	}
	return w, nil
}

// Workflows lists up to limit workflows, newest first, older than before
// when it isn't empty. Ids are UUIDv7, so their order is their age.
func (s *Store) Workflows(ctx context.Context, limit int, before string) ([]Workflow, error) {
	var cursor any // NULL when there's no cursor
	if before != "" {
		cursor = before
	}
	rows, err := s.pool.Query(ctx, `SELECT `+workflowColumns+` FROM workflows
		WHERE $2::uuid IS NULL OR id < $2::uuid ORDER BY id DESC LIMIT $1`, limit, cursor)
	if err != nil {
		return nil, fmt.Errorf("list workflows: %w", translate(err))
	}
	ws, err := pgx.CollectRows(rows, pgx.RowToStructByName[Workflow])
	if err != nil {
		return nil, fmt.Errorf("list workflows: %w", translate(err))
	}
	return ws, nil
}

// Revision fetches one revision, definition included.
func (s *Store) Revision(ctx context.Context, id string, revision int) (Revision, error) {
	r, err := one[Revision](ctx, s.pool, `SELECT `+revisionColumns+` FROM workflow_revisions
		WHERE workflow_id = $1::uuid AND revision = $2`, id, revision)
	if err != nil {
		return Revision{}, fmt.Errorf("get revision %d of %s: %w", revision, id, translate(err))
	}
	return r, nil
}

// Revisions lists a workflow's revisions, newest first, without their
// definitions.
func (s *Store) Revisions(ctx context.Context, id string) ([]Revision, error) {
	if _, err := s.Workflow(ctx, id); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT workflow_id::text AS workflow_id, revision, provenance, created_at
		FROM workflow_revisions WHERE workflow_id = $1::uuid ORDER BY revision DESC`, id)
	if err != nil {
		return nil, fmt.Errorf("list revisions of %s: %w", id, translate(err))
	}
	rs, err := pgx.CollectRows(rows, pgx.RowToStructByNameLax[Revision])
	if err != nil {
		return nil, fmt.Errorf("list revisions of %s: %w", id, translate(err))
	}
	return rs, nil
}

// SaveRevision stores def as the revision after base. base must be the
// latest revision, or the save fails with ErrRevisionMismatch: someone else
// saved in between, and this save would silently undo their change.
func (s *Store) SaveRevision(ctx context.Context, id string, base int, def json.RawMessage, p Provenance) (Revision, error) {
	var r Revision
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var latest int
		// FOR UPDATE: two saves on the same base queue here, and the second
		// sees the first's revision.
		if err := tx.QueryRow(ctx, `SELECT latest_revision FROM workflows WHERE id = $1::uuid FOR UPDATE`, id).Scan(&latest); err != nil {
			return err
		}
		if latest != base {
			return fmt.Errorf("%w: it's at %d, not %d", ErrRevisionMismatch, latest, base)
		}
		var err error
		r, err = one[Revision](ctx, tx, `INSERT INTO workflow_revisions (workflow_id, revision, definition, provenance)
			VALUES ($1::uuid, $2, $3, $4) RETURNING `+revisionColumns, id, latest+1, def, p)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE workflows SET latest_revision = $2 WHERE id = $1::uuid`, id, latest+1)
		return err
	})
	if err != nil {
		return Revision{}, fmt.Errorf("save revision of %s: %w", id, translate(err))
	}
	return r, nil
}

// Publish makes revision the one served. Checking that it's valid is the
// caller's job; this only checks that it exists.
func (s *Store) Publish(ctx context.Context, id string, revision int) (Workflow, error) {
	w, err := one[Workflow](ctx, s.pool, `UPDATE workflows SET published_revision = $2
		WHERE id = $1::uuid AND $2 BETWEEN 1 AND latest_revision RETURNING `+workflowColumns, id, revision)
	if err != nil {
		return Workflow{}, fmt.Errorf("publish revision %d of %s: %w", revision, id, translate(err))
	}
	return w, nil
}

// querier is what pgxpool.Pool and pgx.Tx have in common, for one.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// one runs a query that returns exactly one row, scanned into T by column
// name. No row is pgx.ErrNoRows, which translate turns into ErrNotFound.
func one[T any](ctx context.Context, q querier, sql string, args ...any) (T, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		var zero T
		return zero, err
	}
	return pgx.CollectExactlyOneRow(rows, pgx.RowToStructByName[T])
}
