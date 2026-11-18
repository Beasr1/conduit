package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// A changes list on each workflow (plan 16): what happens to what it uses,
// recorded in the transaction that makes it, so neither commits without the
// other, and never deleted. Who it touches is worked out then and kept;
// whether it's still active is worked out as it's read.

// ChangeDetail is what a line about a change says, each kind with the
// fields it needs. It never holds a constant's value.
type ChangeDetail struct {
	Name      string     `json:"name,omitempty"`       // of what it happened to
	Version   int        `json:"version,omitempty"`    // an upstream's new version
	Revision  int        `json:"revision,omitempty"`   // the revision a workflow published
	How       string     `json:"how,omitempty"`        // a constant's: set, undone or made_secret
	Prefix    string     `json:"prefix,omitempty"`     // a key's first characters; a rotated key's old one's
	ExpiresAt *time.Time `json:"expires_at,omitempty"` // when a rotated key's old value stops
	Keys      int64      `json:"keys,omitempty"`       // how many keys an archive revoked
}

// ChangeRecord is something that happened, as recorded.
type ChangeRecord struct {
	ID         string       `db:"id"`
	Kind       string       `db:"kind"`
	Subject    string       `db:"subject"`    // workflow, upstream, constant or key
	SubjectID  string       `db:"subject_id"` // its id, or a constant's name
	Detail     ChangeDetail `db:"detail"`
	Provenance Provenance   `db:"provenance"`
	CreatedAt  time.Time    `db:"created_at"`
}

// Change is a change on a workflow's list, as it stands now.
type Change struct {
	ChangeRecord
	State       string      `db:"state"` // active, dismissed or done
	DismissedAt *time.Time  `db:"dismissed_at"`
	DismissedBy *Provenance `db:"dismissed_by"`
}

const (
	changeColumns = `c.id::text AS id, c.kind, c.subject, c.subject_id, c.detail, c.provenance, c.created_at`
	// changeState is how workflow entry wc, for change c, stands now. A
	// newer version or revision is active while the workflow's latest
	// revision pins an older one, a rotation while the old key works, and a
	// constant's change until it's dismissed. Nothing else ever waits on
	// anyone, so it's done.
	changeState = `CASE
		WHEN wc.dismissed_at IS NOT NULL THEN 'dismissed'
		WHEN c.kind = 'constant_changed' THEN 'active'
		WHEN c.kind IN ('upstream_version', 'workflow_published') AND EXISTS (
			SELECT 1 FROM workflows w
			JOIN workflow_revisions r ON r.workflow_id = w.id AND r.revision = w.latest_revision
			CROSS JOIN LATERAL ` + nodesOf + `
			WHERE w.id = wc.workflow_id AND CASE c.kind
				WHEN 'upstream_version' THEN n->'uses'->>'upstream' = c.subject_id
					AND (n->'uses'->>'version')::int < (c.detail->>'version')::int
				ELSE n->'uses'->>'workflow' = c.subject_id
					AND (n->'uses'->>'revision')::int < (c.detail->>'revision')::int
				END) THEN 'active'
		WHEN c.kind = 'key_rotated' AND EXISTS (
			SELECT 1 FROM caller_keys k
			WHERE k.id::text = c.subject_id AND k.revoked_at IS NULL AND k.expires_at > now()) THEN 'active'
		ELSE 'done' END`
	// activeChanges is how many of a workflow's changes are active, for its
	// record.
	activeChanges = `(SELECT count(*) FROM workflow_changes wc JOIN changes c ON c.id = wc.change_id
		WHERE wc.workflow_id = workflows.id AND ` + changeState + ` = 'active') AS active_changes`
	workflowChange = `SELECT ` + changeColumns + `, ` + changeState + ` AS state, wc.dismissed_at, wc.dismissed_by
		FROM workflow_changes wc JOIN changes c ON c.id = wc.change_id`
	// pinsOlder is the workflows but $1, not archived, whose latest or
	// published revision pins thing $1, an upstream or a workflow as $2
	// says, at a number under $4, a version or a revision as $3 says.
	pinsOlder = `SELECT DISTINCT w.id::text FROM workflows w
		JOIN workflow_revisions r ON r.workflow_id = w.id AND r.revision IN (w.latest_revision, w.published_revision)
		CROSS JOIN LATERAL ` + nodesOf + `
		WHERE w.archived_at IS NULL AND w.id::text <> $1
			AND n->'uses'->>$2::text = $1 AND (n->'uses'->>$3::text)::int < $4`
)

// record writes what happened, by p, in tx, and puts it on the list of each
// workflow in to.
func record(ctx context.Context, tx pgx.Tx, kind, subject, subjectID string, d ChangeDetail, p Provenance, to ...string) error {
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO changes (kind, subject, subject_id, detail, provenance)
		VALUES ($1, $2, $3, $4, $5) RETURNING id::text`, kind, subject, subjectID, d, p).Scan(&id); err != nil {
		return err
	}
	if len(to) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO workflow_changes (workflow_id, change_id)
		SELECT DISTINCT w::uuid, $2::uuid FROM unnest($1::text[]) w`, to, id)
	return err
}

// pinners is the workflows pinsOlder finds.
func pinners(ctx context.Context, tx pgx.Tx, thing, id string, under int) ([]string, error) {
	number := map[string]string{"upstream": "version", "workflow": "revision"}[thing]
	rows, err := tx.Query(ctx, pinsOlder, id, thing, number, under)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// ids is the ids of uses.
func ids(uses []LiveUse) []string {
	out := make([]string, len(uses))
	for i, u := range uses {
		out[i] = u.ID
	}
	return out
}

// WorkflowChanges lists up to limit of workflow id's changes, its active
// ones or, with history, the rest, newest first, older than before when it
// isn't empty.
func (s *Store) WorkflowChanges(ctx context.Context, id string, history bool, limit int, before string) ([]Change, error) {
	if _, err := s.Workflow(ctx, id); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT * FROM (`+workflowChange+`
		WHERE wc.workflow_id = $1::uuid AND ($3::uuid IS NULL OR c.id < $3::uuid)) l
		WHERE (state = 'active') <> $2 ORDER BY id DESC LIMIT $4`, id, history, orNull(before), limit)
	if err != nil {
		return nil, fmt.Errorf("list the changes of %s: %w", id, translate(err))
	}
	cs, err := pgx.CollectRows(rows, pgx.RowToStructByName[Change])
	if err != nil {
		return nil, fmt.Errorf("list the changes of %s: %w", id, translate(err))
	}
	return cs, nil
}

// DismissChange moves an active change on workflow id's list to its
// history, by p. One that isn't active stays as it is. ErrNotFound: the
// workflow's list has no such change.
func (s *Store) DismissChange(ctx context.Context, id, change string, p Provenance) (Change, error) {
	var c Change
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE workflow_changes wc SET dismissed_at = now(), dismissed_by = $3
			FROM changes c WHERE c.id = wc.change_id AND wc.workflow_id = $1::uuid AND wc.change_id = $2::uuid
			AND `+changeState+` = 'active'`, id, change, p); err != nil {
			return err
		}
		var err error
		c, err = one[Change](ctx, tx, workflowChange+` WHERE wc.workflow_id = $1::uuid AND wc.change_id = $2::uuid`, id, change)
		return err
	})
	if err != nil {
		return Change{}, fmt.Errorf("dismiss change %s of %s: %w", change, id, translate(err))
	}
	return c, nil
}

// SubjectChanges lists up to limit changes to one thing, a subject and its
// id, as recorded, newest first, older than before when it isn't empty.
func (s *Store) SubjectChanges(ctx context.Context, subject, id string, limit int, before string) ([]ChangeRecord, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+changeColumns+` FROM changes c
		WHERE c.subject = $1 AND c.subject_id = $2 AND ($3::uuid IS NULL OR c.id < $3::uuid)
		ORDER BY c.id DESC LIMIT $4`, subject, id, orNull(before), limit)
	if err != nil {
		return nil, fmt.Errorf("list the changes of %s %s: %w", subject, id, translate(err))
	}
	cs, err := pgx.CollectRows(rows, pgx.RowToStructByName[ChangeRecord])
	if err != nil {
		return nil, fmt.Errorf("list the changes of %s %s: %w", subject, id, translate(err))
	}
	return cs, nil
}
