package store

import (
	"context"
	"encoding/json"
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
		var err error
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

// Versions is the upstream versions d's nodes use, decoded, for
// workflow.Resolve (plan 07). One the library doesn't have is left out,
// and Resolve says so of the node that uses it.
func (s *Store) Versions(ctx context.Context, d *workflow.Definition) (workflow.Versions, error) {
	var ids []string
	var versions []int
	for _, n := range d.Nodes {
		if n.Uses != nil {
			ids, versions = append(ids, n.Uses.Upstream), append(versions, n.Uses.Version)
		}
	}
	vs := workflow.Versions{}
	if len(ids) == 0 {
		return vs, nil
	}
	// As text, so an id that isn't a UUID is one the library doesn't have.
	rows, err := s.pool.Query(ctx, `SELECT upstream_id::text, version, definition FROM upstream_versions
		WHERE (upstream_id::text, version) IN (SELECT * FROM unnest($1::text[], $2::int[]))`, ids, versions)
	if err != nil {
		return nil, fmt.Errorf("get the upstreams a definition uses: %w", translate(err))
	}
	defer rows.Close()
	for rows.Next() {
		var ref workflow.Uses
		var def json.RawMessage
		if err := rows.Scan(&ref.Upstream, &ref.Version, &def); err != nil {
			return nil, fmt.Errorf("get the upstreams a definition uses: %w", translate(err))
		}
		var u workflow.Upstream
		if err := json.Unmarshal(def, &u); err != nil {
			return nil, fmt.Errorf("decode version %d of upstream %s: %w", ref.Version, ref.Upstream, err)
		}
		vs[ref] = &u
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("get the upstreams a definition uses: %w", translate(err))
	}
	return vs, nil
}
