package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Run is one execution of a revision.
type Run struct {
	ID              string          `db:"id"`
	WorkflowID      string          `db:"workflow_id"`
	Revision        int             `db:"revision"`
	Trigger         string          `db:"trigger"` // editor or served
	Status          string          `db:"status"`  // running, succeeded, failed or cancelled
	Input           json.RawMessage `db:"input"`   // empty in lists
	Output          json.RawMessage `db:"output"`  // set once it succeeded; empty in lists
	OutputTruncated bool            `db:"output_truncated"`
	Error           json.RawMessage `db:"error"` // {code, detail, node}, once it failed or was cancelled
	StartedAt       time.Time       `db:"started_at"`
	EndedAt         *time.Time      `db:"ended_at"` // nil while it runs
}

// NodeRun is what one node of a run did, written when the node ended.
type NodeRun struct {
	RunID     string          `db:"run_id"`
	NodeID    string          `db:"node_id"`
	Status    string          `db:"status"` // succeeded, failed, skipped or cancelled
	Attempts  int             `db:"attempts"`
	Request   json.RawMessage `db:"request"`  // empty if it sent nothing
	Response  json.RawMessage `db:"response"` // empty if nothing came back
	Error     json.RawMessage `db:"error"`    // {code, detail}, if it failed
	StartedAt *time.Time      `db:"started_at"`
	EndedAt   time.Time       `db:"ended_at"`
}

const (
	runColumns = `id::text AS id, workflow_id::text AS workflow_id, revision, trigger, status,
		input, output, output_truncated, error, started_at, ended_at`
	nodeRunColumns = `run_id::text AS run_id, node_id, status, attempts, request, response, error, started_at, ended_at`
)

// StartRun records a run of revision as running, and returns it with its id.
func (s *Store) StartRun(ctx context.Context, workflowID string, revision int, trigger string, input json.RawMessage) (Run, error) {
	r, err := one[Run](ctx, s.pool, `INSERT INTO runs (workflow_id, revision, trigger, status, input)
		VALUES ($1::uuid, $2, $3, 'running', $4) RETURNING `+runColumns, workflowID, revision, trigger, input)
	if err != nil {
		return Run{}, fmt.Errorf("start a run of %s revision %d: %w", workflowID, revision, translate(err))
	}
	return r, nil
}

// SaveNodeRun records what one node did.
func (s *Store) SaveNodeRun(ctx context.Context, n NodeRun) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO node_runs
		(run_id, node_id, status, attempts, request, response, error, started_at, ended_at)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)`,
		n.RunID, n.NodeID, n.Status, n.Attempts, orNull(n.Request), orNull(n.Response), orNull(n.Error), n.StartedAt, n.EndedAt)
	if err != nil {
		return fmt.Errorf("save node %s of run %s: %w", n.NodeID, n.RunID, translate(err))
	}
	return nil
}

// FinishRun records how a run ended, and returns it as it now stands.
func (s *Store) FinishRun(ctx context.Context, id, status string, output json.RawMessage, truncated bool, errDoc json.RawMessage) (Run, error) {
	r, err := one[Run](ctx, s.pool, `UPDATE runs SET status = $2, output = $3, output_truncated = $4, error = $5, ended_at = now()
		WHERE id = $1::uuid AND status = 'running' RETURNING `+runColumns, id, status, orNull(output), truncated, orNull(errDoc))
	if err != nil {
		return Run{}, fmt.Errorf("finish run %s: %w", id, translate(err))
	}
	return r, nil
}

// MarkInterrupted fails every run still marked running, and says how many
// there were. At startup they're runs a stopped process never finished: a run
// is never resumed (D8). With two server processes, this would fail the other
// one's runs.
func (s *Store) MarkInterrupted(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE runs SET status = 'failed', ended_at = now(),
		error = '{"code": "interrupted", "detail": "The server stopped before the run ended."}'
		WHERE status = 'running'`)
	if err != nil {
		return 0, fmt.Errorf("mark interrupted runs: %w", translate(err))
	}
	return tag.RowsAffected(), nil
}

// Run fetches one run.
func (s *Store) Run(ctx context.Context, id string) (Run, error) {
	r, err := one[Run](ctx, s.pool, `SELECT `+runColumns+` FROM runs WHERE id = $1::uuid`, id)
	if err != nil {
		return Run{}, fmt.Errorf("get run %s: %w", id, translate(err))
	}
	return r, nil
}

// NodeRuns lists what a run's nodes did, in the order they ended.
func (s *Store) NodeRuns(ctx context.Context, runID string) ([]NodeRun, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+nodeRunColumns+` FROM node_runs
		WHERE run_id = $1::uuid ORDER BY ended_at, node_id`, runID)
	if err != nil {
		return nil, fmt.Errorf("list the nodes of run %s: %w", runID, translate(err))
	}
	ns, err := pgx.CollectRows(rows, pgx.RowToStructByName[NodeRun])
	if err != nil {
		return nil, fmt.Errorf("list the nodes of run %s: %w", runID, translate(err))
	}
	return ns, nil
}

// Runs lists up to limit runs, newest first, without their input and
// output: of one workflow when workflowID isn't empty, and older than before
// when it isn't empty.
func (s *Store) Runs(ctx context.Context, workflowID string, limit int, before string) ([]Run, error) {
	rows, err := s.pool.Query(ctx, `SELECT id::text AS id, workflow_id::text AS workflow_id, revision, trigger, status,
		output_truncated, error, started_at, ended_at FROM runs
		WHERE ($2::uuid IS NULL OR workflow_id = $2::uuid) AND ($3::uuid IS NULL OR id < $3::uuid)
		ORDER BY id DESC LIMIT $1`, limit, orNull(workflowID), orNull(before))
	if err != nil {
		return nil, fmt.Errorf("list runs: %w", translate(err))
	}
	rs, err := pgx.CollectRows(rows, pgx.RowToStructByNameLax[Run])
	if err != nil {
		return nil, fmt.Errorf("list runs: %w", translate(err))
	}
	return rs, nil
}

// WorkflowBySlug fetches the workflow served at /serve/{slug}.
func (s *Store) WorkflowBySlug(ctx context.Context, slug string) (Workflow, error) {
	w, err := one[Workflow](ctx, s.pool, `SELECT `+workflowColumns+` FROM workflows WHERE slug = $1`, slug)
	if err != nil {
		return Workflow{}, fmt.Errorf("get workflow %q: %w", slug, translate(err))
	}
	return w, nil
}

// orNull is v as a query argument, with the empty value as SQL NULL: an
// absent document, or no filter.
func orNull[T ~string | ~[]byte](v T) any {
	if len(v) == 0 {
		return nil
	}
	return v
}
