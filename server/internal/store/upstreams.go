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
	ID            string      `db:"id"`
	Name          string      `db:"name"`
	LatestVersion int         `db:"latest_version"`
	CreatedAt     time.Time   `db:"created_at"`
	ArchivedAt    *time.Time  `db:"archived_at"` // nil unless it's archived (plan 15)
	ArchivedBy    *Provenance `db:"archived_by"`
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
	upstreamColumns = `id::text AS id, name, latest_version, created_at, archived_at, archived_by`
	versionColumns  = `upstream_id::text AS upstream_id, version, definition, provenance, created_at`
)

// CreateUpstream stores a new upstream with def as version 1. A name in use
// is ErrConflict, and one only an archived upstream has, ErrArchivedName.
func (s *Store) CreateUpstream(ctx context.Context, name string, def json.RawMessage, p Provenance) (Upstream, UpstreamVersion, error) {
	var u Upstream
	var v UpstreamVersion
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		err := archivedName(ctx, tx, `SELECT 1 FROM upstreams WHERE name = $1 AND archived_at IS NOT NULL`, name)
		if err != nil {
			return err
		}
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

// Upstreams lists up to limit upstreams, the archived ones or those in use,
// newest first, older than before when it isn't empty. Ids are UUIDv7, so
// their order is their age.
func (s *Store) Upstreams(ctx context.Context, limit int, before string, archived bool) ([]Upstream, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+upstreamColumns+` FROM upstreams
		WHERE (archived_at IS NOT NULL) = $3 AND ($2::uuid IS NULL OR id < $2::uuid) ORDER BY id DESC LIMIT $1`, limit, orNull(before), archived)
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
// it was. An archived upstream is ErrArchived.
func (s *Store) SaveUpstreamVersion(ctx context.Context, id string, base int, def json.RawMessage, p Provenance) (UpstreamVersion, error) {
	var v UpstreamVersion
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var latest int
		var archived bool
		// FOR UPDATE: two saves on the same base queue here, and the second
		// sees the first's version.
		if err := tx.QueryRow(ctx, `SELECT latest_version, archived_at IS NOT NULL FROM upstreams WHERE id = $1::uuid FOR UPDATE`, id).Scan(&latest, &archived); err != nil {
			return err
		}
		if archived {
			return ErrArchived
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

// UpstreamUse is a latest or published revision of a workflow not archived
// that uses an upstream, directly or through what it pins: the versions it
// reaches, oldest first, and whether it's the revision the workflow serves.
type UpstreamUse struct {
	WorkflowID string `db:"workflow_id"`
	Name       string `db:"name"`
	Revision   int    `db:"revision"`
	Versions   []int  `db:"versions"`
	Published  bool   `db:"published"`
}

// UpstreamUsers lists what ArchiveUpstream is refused for: the revisions in
// use that use upstream id, by workflow name, oldest revision first.
func (s *Store) UpstreamUsers(ctx context.Context, id string) ([]UpstreamUse, error) {
	if _, err := s.Upstream(ctx, id); err != nil {
		return nil, err
	}
	us, err := usesOf(ctx, s.pool, id)
	if err != nil {
		return nil, fmt.Errorf("list the users of upstream %s: %w", id, translate(err))
	}
	return us, nil
}

func usesOf(ctx context.Context, q querier, id string) ([]UpstreamUse, error) {
	rows, err := q.Query(ctx, upstreamUsers, id)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByName[UpstreamUse])
}

// Deps is what d's nodes use, decoded, for workflow.Resolve (plan 07): the
// upstream versions, and the workflow revisions with what each of those
// uses in turn, so theirs resolve too, and which of it all is archived, and
// the constants it reads (plan 15). A query for each, each round, and none
// asked twice, so it ends even on a draft that uses itself. One the store
// doesn't have is left out, and Resolve says so of the node that uses it.
func (s *Store) Deps(ctx context.Context, d *workflow.Definition) (workflow.Deps, error) {
	return depsOf(ctx, s.pool, d)
}

func depsOf(ctx context.Context, q querier, d *workflow.Definition) (workflow.Deps, error) {
	known, err := constantNames(ctx, q)
	if err != nil {
		return workflow.Deps{}, err
	}
	deps := workflow.Deps{
		Versions: workflow.Versions{}, Revisions: workflow.Revisions{}, Constants: known,
		Archived: map[string]string{}, Reads: map[workflow.Uses][]string{},
	}
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
		if err := versions(ctx, q, ups, deps); err != nil {
			return workflow.Deps{}, err
		}
		var err error
		if todo, err = revisions(ctx, q, wfs, deps); err != nil {
			return workflow.Deps{}, err
		}
	}
	return deps, nil
}

// revisions adds the workflow revisions refs name to deps, decoded, and
// gives back those it added.
func revisions(ctx context.Context, q querier, refs []workflow.Uses, deps workflow.Deps) ([]*workflow.Definition, error) {
	if len(refs) == 0 {
		return nil, nil
	}
	ids, revs := make([]string, len(refs)), make([]int, len(refs))
	for i, r := range refs {
		ids[i], revs[i] = r.Workflow, r.Revision
	}
	// As text, so an id that isn't a UUID is one the store doesn't have.
	rows, err := q.Query(ctx, `SELECT r.workflow_id::text, r.revision, r.definition, w.name, w.archived_at IS NOT NULL
		FROM workflow_revisions r JOIN workflows w ON w.id = r.workflow_id
		WHERE (r.workflow_id::text, r.revision) IN (SELECT * FROM unnest($1::text[], $2::int[]))`, ids, revs)
	if err != nil {
		return nil, fmt.Errorf("get the workflows a definition uses: %w", translate(err))
	}
	defer rows.Close()
	var added []*workflow.Definition
	for rows.Next() {
		var ref workflow.Uses
		var def json.RawMessage
		var name string
		var archived bool
		if err := rows.Scan(&ref.Workflow, &ref.Revision, &def, &name, &archived); err != nil {
			return nil, fmt.Errorf("get the workflows a definition uses: %w", translate(err))
		}
		var d workflow.Definition
		if err := json.Unmarshal(def, &d); err != nil {
			return nil, fmt.Errorf("decode revision %d of workflow %s: %w", ref.Revision, ref.Workflow, err)
		}
		deps.Revisions[ref] = &d
		deps.Reads[ref] = constantsIn(def)
		if archived {
			deps.Archived[ref.Workflow] = name
		}
		added = append(added, &d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("get the workflows a definition uses: %w", translate(err))
	}
	return added, nil
}

// versions adds the upstream versions refs name to deps, decoded.
func versions(ctx context.Context, q querier, refs []workflow.Uses, deps workflow.Deps) error {
	if len(refs) == 0 {
		return nil
	}
	ids, nums := make([]string, len(refs)), make([]int, len(refs))
	for i, r := range refs {
		ids[i], nums[i] = r.Upstream, r.Version
	}
	// As text, so an id that isn't a UUID is one the library doesn't have.
	rows, err := q.Query(ctx, `SELECT v.upstream_id::text, v.version, v.definition, u.name, u.archived_at IS NOT NULL
		FROM upstream_versions v JOIN upstreams u ON u.id = v.upstream_id
		WHERE (v.upstream_id::text, v.version) IN (SELECT * FROM unnest($1::text[], $2::int[]))`, ids, nums)
	if err != nil {
		return fmt.Errorf("get the upstreams a definition uses: %w", translate(err))
	}
	defer rows.Close()
	for rows.Next() {
		var ref workflow.Uses
		var def json.RawMessage
		var name string
		var archived bool
		if err := rows.Scan(&ref.Upstream, &ref.Version, &def, &name, &archived); err != nil {
			return fmt.Errorf("get the upstreams a definition uses: %w", translate(err))
		}
		var u workflow.Upstream
		if err := json.Unmarshal(def, &u); err != nil {
			return fmt.Errorf("decode version %d of upstream %s: %w", ref.Version, ref.Upstream, err)
		}
		deps.Versions[ref] = &u
		deps.Reads[ref] = constantsIn(def)
		if archived {
			deps.Archived[ref.Upstream] = name
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("get the upstreams a definition uses: %w", translate(err))
	}
	return nil
}
