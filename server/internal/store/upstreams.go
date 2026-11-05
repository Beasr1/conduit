package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Beasr1/conduit/server/internal/workflow"
)

// Upstream is a saved API endpoint's identity and its newest version
// (plan 07).
type Upstream struct {
	ID            string    `db:"id"`
	Name          string    `db:"name"`
	LatestVersion int       `db:"latest_version"`
	CreatedAt     time.Time `db:"created_at"`
}

// UpstreamVersion is one saved version of an upstream. It never changes
// once written, so a step that pins it always calls the same way.
type UpstreamVersion struct {
	UpstreamID string          `db:"upstream_id"`
	Version    int             `db:"version"`
	Definition json.RawMessage `db:"definition"`
	Provenance Provenance      `db:"provenance"`
	CreatedAt  time.Time       `db:"created_at"`
}

const (
	upstreamColumns = `id::text AS id, name, latest_version, created_at`
	versionColumns  = `upstream_id::text AS upstream_id, version, definition, provenance, created_at`
)

// CreateUpstream stores a new upstream with def as version 1.
func (s *Store) CreateUpstream(ctx context.Context, name string, def json.RawMessage, p Provenance) (Upstream, UpstreamVersion, error) {
	var u Upstream
	var v UpstreamVersion
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var err error
		u, err = one[Upstream](ctx, tx, `INSERT INTO upstreams (name, latest_version) VALUES ($1, 1)
			RETURNING `+upstreamColumns, name)
		if err != nil {
			return err
		}
		v, err = one[UpstreamVersion](ctx, tx, `INSERT INTO upstream_versions (upstream_id, version, definition, provenance)
			VALUES ($1::uuid, 1, $2, $3) RETURNING `+versionColumns, u.ID, def, p)
		return err
	})
	if err != nil {
		return Upstream{}, UpstreamVersion{}, fmt.Errorf("create upstream: %w", translate(err))
	}
	return u, v, nil
}

// Upstream fetches one upstream.
func (s *Store) Upstream(ctx context.Context, id string) (Upstream, error) {
	u, err := one[Upstream](ctx, s.pool, `SELECT `+upstreamColumns+` FROM upstreams WHERE id = $1::uuid`, id)
	if err != nil {
		return Upstream{}, fmt.Errorf("get upstream %s: %w", id, translate(err))
	}
	return u, nil
}

// Upstreams lists up to limit upstreams, newest first, older than before
// when it isn't empty. Ids are UUIDv7, so their order is their age.
func (s *Store) Upstreams(ctx context.Context, limit int, before string) ([]Upstream, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+upstreamColumns+` FROM upstreams
		WHERE $2::uuid IS NULL OR id < $2::uuid ORDER BY id DESC LIMIT $1`, limit, orNull(before))
	if err != nil {
		return nil, fmt.Errorf("list upstreams: %w", translate(err))
	}
	us, err := pgx.CollectRows(rows, pgx.RowToStructByName[Upstream])
	if err != nil {
		return nil, fmt.Errorf("list upstreams: %w", translate(err))
	}
	return us, nil
}

// UpstreamVersion fetches one version of an upstream, definition included.
func (s *Store) UpstreamVersion(ctx context.Context, id string, version int) (UpstreamVersion, error) {
	v, err := one[UpstreamVersion](ctx, s.pool, `SELECT `+versionColumns+` FROM upstream_versions
		WHERE upstream_id = $1::uuid AND version = $2`, id, version)
	if err != nil {
		return UpstreamVersion{}, fmt.Errorf("get version %d of upstream %s: %w", version, id, translate(err))
	}
	return v, nil
}

// SaveUpstreamVersion stores def as the version after base. base must be
// the latest version, or the save fails with ErrVersionMismatch: someone
// else saved in between, and this save would silently undo their change.
// A def that's base's, by value, makes no version: base is the answer, as
// it was.
func (s *Store) SaveUpstreamVersion(ctx context.Context, id string, base int, def json.RawMessage, p Provenance) (UpstreamVersion, error) {
	var v UpstreamVersion
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var latest int
		// FOR UPDATE: two saves on the same base queue here, and the second
		// sees the first's version.
		if err := tx.QueryRow(ctx, `SELECT latest_version FROM upstreams WHERE id = $1::uuid FOR UPDATE`, id).Scan(&latest); err != nil {
			return err
		}
		if latest != base {
			return fmt.Errorf("%w: it's at %d, not %d", ErrVersionMismatch, latest, base)
		}
		// jsonb compares by value, so key order and spacing don't count.
		var err error
		v, err = one[UpstreamVersion](ctx, tx, `SELECT `+versionColumns+` FROM upstream_versions
			WHERE upstream_id = $1::uuid AND version = $2 AND definition = $3::jsonb`, id, base, def)
		if !errors.Is(err, pgx.ErrNoRows) {
			return err // nil: nothing changed
		}
		v, err = one[UpstreamVersion](ctx, tx, `INSERT INTO upstream_versions (upstream_id, version, definition, provenance)
			VALUES ($1::uuid, $2, $3, $4) RETURNING `+versionColumns, id, latest+1, def, p)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE upstreams SET latest_version = $2 WHERE id = $1::uuid`, id, latest+1)
		return err
	})
	if err != nil {
		return UpstreamVersion{}, fmt.Errorf("save upstream %s on version %d: %w", id, base, translate(err))
	}
	return v, nil
}

// UpstreamPin is a workflow with saved revisions that pin an upstream:
// which ones, oldest first.
type UpstreamPin struct {
	WorkflowID string `db:"workflow_id"`
	Name       string `db:"name"`
	Revisions  []int  `db:"revisions"`
}

// InUseError is a delete refused because saved revisions pin what it
// would delete: a revision never changes, and each must keep running
// (plan 07).
type InUseError struct {
	Pins []UpstreamPin
}

func (e *InUseError) Error() string {
	return fmt.Sprintf("saved revisions of %d workflows pin it", len(e.Pins))
}

// DeleteUpstream deletes upstream id and every version of it, unless a
// saved revision of a workflow, published or not, pins one of them: then
// it's refused with an *InUseError naming them.
func (s *Store) DeleteUpstream(ctx context.Context, id string) error {
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// SHARE lets reads through and holds back every insert, so no
		// revision is saved, pinning it, between the check and the delete.
		if _, err := tx.Exec(ctx, `LOCK TABLE workflow_revisions IN SHARE MODE`); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT 1 FROM upstreams WHERE id = $1::uuid FOR UPDATE`, id).Scan(new(int)); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT w.id::text AS workflow_id, w.name,
			array_agg(DISTINCT r.revision ORDER BY r.revision) AS revisions
			FROM workflow_revisions r
			JOIN workflows w ON w.id = r.workflow_id
			-- A definition saved with no nodes has them as null, not [].
			CROSS JOIN LATERAL jsonb_array_elements(CASE jsonb_typeof(r.definition->'nodes') WHEN 'array' THEN r.definition->'nodes' ELSE '[]' END) n
			WHERE n->'uses'->>'upstream' = $1
			GROUP BY w.id, w.name
			ORDER BY w.id`, id)
		if err != nil {
			return err
		}
		pins, err := pgx.CollectRows(rows, pgx.RowToStructByName[UpstreamPin])
		if err != nil {
			return err
		}
		if len(pins) > 0 {
			return &InUseError{Pins: pins}
		}
		// Its versions go with it (ON DELETE CASCADE).
		_, err = tx.Exec(ctx, `DELETE FROM upstreams WHERE id = $1::uuid`, id)
		return err
	})
	if err != nil {
		return fmt.Errorf("delete upstream %s: %w", id, translate(err))
	}
	return nil
}

// UpstreamUse is a workflow whose latest revision uses an upstream: the
// versions its nodes pin, oldest first, and whether that revision is the
// one the workflow serves.
type UpstreamUse struct {
	WorkflowID string `db:"workflow_id"`
	Name       string `db:"name"`
	Revision   int    `db:"revision"`
	Versions   []int  `db:"versions"`
	Published  bool   `db:"published"`
}

// UpstreamUsers lists the workflows whose latest revision uses upstream
// id, newest first.
func (s *Store) UpstreamUsers(ctx context.Context, id string) ([]UpstreamUse, error) {
	if _, err := s.Upstream(ctx, id); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT w.id::text AS workflow_id, w.name, r.revision,
		array_agg(DISTINCT (n->'uses'->>'version')::int ORDER BY (n->'uses'->>'version')::int) AS versions,
		COALESCE(w.published_revision = r.revision, false) AS published
		FROM workflows w
		JOIN workflow_revisions r ON r.workflow_id = w.id AND r.revision = w.latest_revision
		-- A definition saved with no nodes has them as null, not [].
		CROSS JOIN LATERAL jsonb_array_elements(CASE jsonb_typeof(r.definition->'nodes') WHEN 'array' THEN r.definition->'nodes' ELSE '[]' END) n
		WHERE n->'uses'->>'upstream' = $1
		GROUP BY w.id, w.name, r.revision, w.published_revision
		ORDER BY w.id DESC`, id)
	if err != nil {
		return nil, fmt.Errorf("list the users of upstream %s: %w", id, translate(err))
	}
	us, err := pgx.CollectRows(rows, pgx.RowToStructByName[UpstreamUse])
	if err != nil {
		return nil, fmt.Errorf("list the users of upstream %s: %w", id, translate(err))
	}
	return us, nil
}

// Deps is what d's nodes use, decoded, for workflow.Resolve (plan 07): the
// upstream versions, and the workflow revisions with what each of those
// uses in turn, so theirs resolve too. A query for each, each round, and
// none asked twice, so it ends even on a draft that uses itself. One the
// store doesn't have is left out, and Resolve says so of the node that
// uses it.
func (s *Store) Deps(ctx context.Context, d *workflow.Definition) (workflow.Deps, error) {
	known, err := s.ConstantNames(ctx)
	if err != nil {
		return workflow.Deps{}, err
	}
	deps := workflow.Deps{Versions: workflow.Versions{}, Revisions: workflow.Revisions{}, Constants: known}
	asked := map[workflow.Uses]bool{}
	for todo := []*workflow.Definition{d}; len(todo) > 0; {
		var ups, wfs []workflow.Uses
		for _, def := range todo {
			for _, n := range def.Nodes {
				if n.Uses == nil || asked[*n.Uses] {
					continue
				}
				asked[*n.Uses] = true
				if n.Uses.Workflow != "" {
					wfs = append(wfs, *n.Uses)
				} else {
					ups = append(ups, *n.Uses)
				}
			}
		}
		if err := s.versions(ctx, ups, deps.Versions); err != nil {
			return workflow.Deps{}, err
		}
		var err error
		if todo, err = s.revisions(ctx, wfs, deps.Revisions); err != nil {
			return workflow.Deps{}, err
		}
	}
	return deps, nil
}

// revisions adds the workflow revisions refs name to rs, decoded, and
// gives back those it added.
func (s *Store) revisions(ctx context.Context, refs []workflow.Uses, rs workflow.Revisions) ([]*workflow.Definition, error) {
	if len(refs) == 0 {
		return nil, nil
	}
	ids, revs := make([]string, len(refs)), make([]int, len(refs))
	for i, r := range refs {
		ids[i], revs[i] = r.Workflow, r.Revision
	}
	// As text, so an id that isn't a UUID is one the store doesn't have.
	rows, err := s.pool.Query(ctx, `SELECT workflow_id::text, revision, definition FROM workflow_revisions
		WHERE (workflow_id::text, revision) IN (SELECT * FROM unnest($1::text[], $2::int[]))`, ids, revs)
	if err != nil {
		return nil, fmt.Errorf("get the workflows a definition uses: %w", translate(err))
	}
	defer rows.Close()
	var added []*workflow.Definition
	for rows.Next() {
		var ref workflow.Uses
		var def json.RawMessage
		if err := rows.Scan(&ref.Workflow, &ref.Revision, &def); err != nil {
			return nil, fmt.Errorf("get the workflows a definition uses: %w", translate(err))
		}
		var d workflow.Definition
		if err := json.Unmarshal(def, &d); err != nil {
			return nil, fmt.Errorf("decode revision %d of workflow %s: %w", ref.Revision, ref.Workflow, err)
		}
		rs[ref] = &d
		added = append(added, &d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("get the workflows a definition uses: %w", translate(err))
	}
	return added, nil
}

// versions adds the upstream versions refs name to vs, decoded.
func (s *Store) versions(ctx context.Context, refs []workflow.Uses, vs workflow.Versions) error {
	if len(refs) == 0 {
		return nil
	}
	ids, versions := make([]string, len(refs)), make([]int, len(refs))
	for i, r := range refs {
		ids[i], versions[i] = r.Upstream, r.Version
	}
	// As text, so an id that isn't a UUID is one the library doesn't have.
	rows, err := s.pool.Query(ctx, `SELECT upstream_id::text, version, definition FROM upstream_versions
		WHERE (upstream_id::text, version) IN (SELECT * FROM unnest($1::text[], $2::int[]))`, ids, versions)
	if err != nil {
		return fmt.Errorf("get the upstreams a definition uses: %w", translate(err))
	}
	defer rows.Close()
	for rows.Next() {
		var ref workflow.Uses
		var def json.RawMessage
		if err := rows.Scan(&ref.Upstream, &ref.Version, &def); err != nil {
			return fmt.Errorf("get the upstreams a definition uses: %w", translate(err))
		}
		var u workflow.Upstream
		if err := json.Unmarshal(def, &u); err != nil {
			return fmt.Errorf("decode version %d of upstream %s: %w", ref.Version, ref.Upstream, err)
		}
		vs[ref] = &u
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("get the upstreams a definition uses: %w", translate(err))
	}
	return nil
}
