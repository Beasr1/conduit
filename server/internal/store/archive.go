package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Archive, never delete (plan 15): a workflow, an upstream or a constant
// nothing live uses is taken out of use, and kept, read-only, until it's
// restored. What's archived says so on its row, and every change refuses it.

var (
	// ErrArchived is a change to something archived, which only Restore
	// changes.
	ErrArchived = errors.New("it's archived")
	// ErrArchivedName is a name only something archived has. It stays
	// taken, so a caller of /serve/old-slug never reaches a workflow made
	// later under it.
	ErrArchivedName = fmt.Errorf("%w by something archived", ErrConflict)
)

// LiveUse is a workflow or an upstream in use that uses something: its id,
// its name, and which of its revisions or versions do, oldest first.
type LiveUse struct {
	ID   string `db:"id"`
	Name string `db:"name"`
	At   []int  `db:"at"`
}

// InUseError is an archive refused because something live uses what it
// would archive: archived means nothing runs on it.
type InUseError struct {
	Workflows []LiveUse
	Upstreams []LiveUse
}

func (e *InUseError) Error() string {
	return fmt.Sprintf("%d workflows and %d upstreams use it", len(e.Workflows), len(e.Upstreams))
}

const (
	// nodesOf is the nodes of definition r as rows. A definition saved with
	// no nodes has them as null, not [].
	nodesOf = `jsonb_array_elements(CASE jsonb_typeof(r.definition->'nodes') WHEN 'array' THEN r.definition->'nodes' ELSE '[]' END) n`
	// live is what's in use: the latest and published revisions of each
	// workflow not archived, as workflow_id and revision, each beside itself
	// and every revision it pins, however far in, as at_workflow and
	// at_revision. UNION drops a row it has, so it ends even on drafts that
	// use each other.
	live = `WITH RECURSIVE live (workflow_id, revision, at_workflow, at_revision) AS (
		SELECT w.id, r.revision, w.id, r.revision
		FROM workflows w JOIN workflow_revisions r ON r.workflow_id = w.id
		WHERE w.archived_at IS NULL AND r.revision IN (w.latest_revision, w.published_revision)
		UNION
		SELECT l.workflow_id, l.revision, pinned.workflow_id, pinned.revision
		FROM live l
		JOIN workflow_revisions r ON r.workflow_id = l.at_workflow AND r.revision = l.at_revision
		CROSS JOIN LATERAL ` + nodesOf + `
		-- As text, so an id that isn't a UUID is one the store doesn't have.
		JOIN workflow_revisions pinned ON pinned.workflow_id::text = n->'uses'->>'workflow'
			AND pinned.revision = (n->'uses'->>'revision')::int
	) `
	// reached joins what a live row reaches, as r, and whose it is, as w.
	reached = ` FROM live l JOIN workflows w ON w.id = l.workflow_id
		JOIN workflow_revisions r ON r.workflow_id = l.at_workflow AND r.revision = l.at_revision `

	workflowUsers = live + `SELECT w.id::text AS id, w.name, array_agg(DISTINCT l.revision ORDER BY l.revision) AS at
		FROM live l JOIN workflows w ON w.id = l.workflow_id
		WHERE l.at_workflow = $1::uuid AND l.workflow_id <> $1::uuid
		GROUP BY w.id, w.name ORDER BY w.name, w.id`
	upstreamUsers = live + `SELECT w.id::text AS workflow_id, w.name, l.revision,
		array_agg(DISTINCT (n->'uses'->>'version')::int ORDER BY (n->'uses'->>'version')::int) AS versions,
		COALESCE(w.published_revision = l.revision, false) AS published` + reached + `
		CROSS JOIN LATERAL ` + nodesOf + `
		WHERE n->'uses'->>'upstream' = $1
		GROUP BY w.id, w.name, l.revision, w.published_revision
		ORDER BY w.name, w.id, l.revision`
	// $1 is readPattern's, in these two.
	workflowReaders = live + `SELECT w.id::text AS id, w.name, array_agg(DISTINCT l.revision ORDER BY l.revision) AS at` + reached + `
		WHERE r.definition::text ~ $1 OR EXISTS (
			SELECT 1 FROM ` + nodesOf + `
			JOIN upstream_versions v ON v.upstream_id::text = n->'uses'->>'upstream'
				AND v.version = (n->'uses'->>'version')::int
			WHERE v.definition::text ~ $1)
		GROUP BY w.id, w.name ORDER BY w.name, w.id`
	upstreamReaders = `SELECT u.id::text AS id, u.name, ARRAY[u.latest_version] AS at
		FROM upstreams u JOIN upstream_versions v ON v.upstream_id = u.id AND v.version = u.latest_version
		WHERE u.archived_at IS NULL AND v.definition::text ~ $1
		ORDER BY u.name, u.id`
)

// liveUses runs one of the queries above that lists LiveUses.
func liveUses(ctx context.Context, q querier, sql, arg string) ([]LiveUse, error) {
	rows, err := q.Query(ctx, sql, arg)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByName[LiveUse])
}

// archiveLock is the one advisory lock there is, so any number does: plan
// 15's.
const archiveLock int64 = 15

// lockArchive takes the lock, until tx ends, that an archive holds from its
// check that nothing live uses a thing until the thing is archived, and a
// publish from its check of a revision until the revision is live. So a
// publish can't put live what an archive is taking out of use. Nothing else
// needs it: a draft may use what's archived, and a run that started first
// reads only pinned versions, which stay.
func lockArchive(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, archiveLock)
	return err
}

// notArchived is ErrArchived if workflow id is archived, and ErrNotFound if
// there's no such workflow. Otherwise the row is shared with tx until it
// ends, so an archive, which locks it, waits.
func notArchived(ctx context.Context, tx pgx.Tx, id string) error {
	var archived bool
	if err := tx.QueryRow(ctx, `SELECT archived_at IS NOT NULL FROM workflows WHERE id = $1::uuid FOR SHARE`, id).Scan(&archived); err != nil {
		return err
	}
	if archived {
		return ErrArchived
	}
	return nil
}

// archivedName is ErrArchivedName if query, given name, finds a row. Without
// this, making something would refuse it as ErrConflict, saying nothing of
// what has the name.
func archivedName(ctx context.Context, q querier, query, name string) error {
	rows, err := q.Query(ctx, query, name)
	if err != nil {
		return err
	}
	found, err := pgx.CollectRows(rows, pgx.RowTo[int])
	switch {
	case err != nil:
		return err
	case len(found) > 0:
		return ErrArchivedName
	}
	return nil
}

// ArchiveWorkflow takes workflow id out of use and revokes its keys, so its
// URL stops answering at once. It's refused with an *InUseError while a
// live workflow uses it. Archiving one archived already changes nothing.
func (s *Store) ArchiveWorkflow(ctx context.Context, id string, p Provenance) (Workflow, error) {
	var w Workflow
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := lockArchive(ctx, tx); err != nil {
			return err
		}
		var err error
		if w, err = one[Workflow](ctx, tx, `SELECT `+workflowColumns+` FROM workflows WHERE id = $1::uuid FOR UPDATE`, id); err != nil {
			return err
		}
		if w.ArchivedAt != nil {
			return nil
		}
		users, err := liveUses(ctx, tx, workflowUsers, id)
		if err != nil {
			return err
		}
		if len(users) > 0 {
			return &InUseError{Workflows: users}
		}
		// A key past its expiry stays expired, as RevokeKey leaves it.
		if _, err := tx.Exec(ctx, `UPDATE caller_keys SET revoked_at = now()
			WHERE workflow_id = $1::uuid AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, id); err != nil {
			return err
		}
		w, err = one[Workflow](ctx, tx, `UPDATE workflows SET archived_at = now(), archived_by = $2
			WHERE id = $1::uuid RETURNING `+workflowColumns, id, p)
		return err
	})
	if err != nil {
		return Workflow{}, fmt.Errorf("archive workflow %s: %w", id, translate(err))
	}
	return w, nil
}

// RestoreWorkflow brings workflow id back as it was, without keys. It's
// never refused: if what it uses is archived too, its problems say so.
func (s *Store) RestoreWorkflow(ctx context.Context, id string) (Workflow, error) {
	w, err := one[Workflow](ctx, s.pool, `UPDATE workflows SET archived_at = NULL, archived_by = NULL
		WHERE id = $1::uuid RETURNING `+workflowColumns, id)
	if err != nil {
		return Workflow{}, fmt.Errorf("restore workflow %s: %w", id, translate(err))
	}
	return w, nil
}

// ArchiveUpstream takes upstream id out of use. It's refused with an
// *InUseError while a live workflow uses it. Archiving one archived already
// changes nothing.
func (s *Store) ArchiveUpstream(ctx context.Context, id string, p Provenance) (Upstream, error) {
	var u Upstream
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := lockArchive(ctx, tx); err != nil {
			return err
		}
		var err error
		if u, err = one[Upstream](ctx, tx, `SELECT `+upstreamColumns+` FROM upstreams WHERE id = $1::uuid FOR UPDATE`, id); err != nil {
			return err
		}
		if u.ArchivedAt != nil {
			return nil
		}
		uses, err := usesOf(ctx, tx, id)
		if err != nil {
			return err
		}
		if len(uses) > 0 {
			return &InUseError{Workflows: byWorkflow(uses)}
		}
		u, err = one[Upstream](ctx, tx, `UPDATE upstreams SET archived_at = now(), archived_by = $2
			WHERE id = $1::uuid RETURNING `+upstreamColumns, id, p)
		return err
	})
	if err != nil {
		return Upstream{}, fmt.Errorf("archive upstream %s: %w", id, translate(err))
	}
	return u, nil
}

// byWorkflow gathers uses, which come a workflow at a time, into a LiveUse
// each.
func byWorkflow(uses []UpstreamUse) []LiveUse {
	var out []LiveUse
	for _, u := range uses {
		if n := len(out); n > 0 && out[n-1].ID == u.WorkflowID {
			out[n-1].At = append(out[n-1].At, u.Revision)
			continue
		}
		out = append(out, LiveUse{ID: u.WorkflowID, Name: u.Name, At: []int{u.Revision}})
	}
	return out
}

// RestoreUpstream brings upstream id back as it was.
func (s *Store) RestoreUpstream(ctx context.Context, id string) (Upstream, error) {
	u, err := one[Upstream](ctx, s.pool, `UPDATE upstreams SET archived_at = NULL, archived_by = NULL
		WHERE id = $1::uuid RETURNING `+upstreamColumns, id)
	if err != nil {
		return Upstream{}, fmt.Errorf("restore upstream %s: %w", id, translate(err))
	}
	return u, nil
}

// ArchiveConstant takes a constant out of use. Its value stays sealed, for
// Restore, and runs go on masking a secret one. It's refused with an
// *InUseError while something live reads it. Archiving one archived already
// changes nothing.
func (s *Store) ArchiveConstant(ctx context.Context, name string, p Provenance) (Constant, error) {
	var out Constant
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := lockArchive(ctx, tx); err != nil {
			return err
		}
		c, err := one[sealed](ctx, tx, `SELECT `+constantColumns+` FROM constants WHERE name = $1 FOR UPDATE`, name)
		if err != nil {
			return err
		}
		if c.ArchivedAt == nil {
			users, err := readersOf(ctx, tx, name)
			if err != nil {
				return err
			}
			if len(users.Workflows)+len(users.Upstreams) > 0 {
				return &InUseError{Workflows: users.Workflows, Upstreams: users.Upstreams}
			}
			if c, err = one[sealed](ctx, tx, `UPDATE constants SET archived_at = now(), archived_by = $2
				WHERE name = $1 RETURNING `+constantColumns, name, p); err != nil {
				return err
			}
		}
		out, err = s.open(c)
		return err
	})
	if err != nil {
		return Constant{}, fmt.Errorf("archive constant %s: %w", name, translate(err))
	}
	return out, nil
}

// RestoreConstant brings a constant back as it was, with its value and the
// one before it.
func (s *Store) RestoreConstant(ctx context.Context, name string) (Constant, error) {
	c, err := one[sealed](ctx, s.pool, `UPDATE constants SET archived_at = NULL, archived_by = NULL
		WHERE name = $1 RETURNING `+constantColumns, name)
	if err != nil {
		return Constant{}, fmt.Errorf("restore constant %s: %w", name, translate(err))
	}
	return s.open(c)
}
