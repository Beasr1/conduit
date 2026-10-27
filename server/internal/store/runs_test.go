package store_test

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/Beasr1/conduit/server/internal/store"
)

func startRun(t *testing.T, w store.Workflow) store.Run {
	t.Helper()
	r, err := db.StartRun(t.Context(), w.ID, 1, "editor", json.RawMessage(`{"user_id":"7"}`))
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestRun_StartRecordFinish(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	w := create(t)
	r := startRun(t, w)
	if len(r.ID) != 36 || r.WorkflowID != w.ID || r.Revision != 1 || r.Trigger != "editor" || r.Status != "running" ||
		string(r.Input) != `{"user_id": "7"}` || r.Output != nil || r.Error != nil || r.EndedAt != nil {
		t.Errorf("started run = %+v", r)
	}

	started := time.Now().Add(-time.Second).Truncate(time.Microsecond) // what Postgres keeps
	nodes := []store.NodeRun{
		{
			RunID: r.ID, NodeID: "user", Status: "failed", Attempts: 2, StartedAt: &started, EndedAt: time.Now(),
			Request:  json.RawMessage(`{"method":"GET","url":"https://api.example.com/users/7"}`),
			Response: json.RawMessage(`{"status":503,"body":null}`),
			Error:    json.RawMessage(`{"code":"upstream_failed","detail":"status 503"}`),
		},
		{RunID: r.ID, NodeID: "orders", Status: "cancelled", EndedAt: time.Now().Add(time.Millisecond)},
	}
	for _, n := range nodes {
		if err := db.SaveNodeRun(ctx, n); err != nil {
			t.Fatal(err)
		}
	}
	got, err := db.NodeRuns(ctx, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].NodeID != "user" || got[1].NodeID != "orders" {
		t.Fatalf("NodeRuns() = %+v", got)
	}
	if u := got[0]; u.Attempts != 2 || u.StartedAt == nil || !u.StartedAt.Equal(started) ||
		string(u.Error) != `{"code": "upstream_failed", "detail": "status 503"}` || string(u.Response) != `{"body": null, "status": 503}` {
		t.Errorf("user = %+v, error %s, response %s", u, u.Error, u.Response)
	}
	if o := got[1]; o.Request != nil || o.Response != nil || o.Error != nil || o.StartedAt != nil {
		t.Errorf("orders, which never started = %+v", o)
	}

	done, err := db.FinishRun(ctx, r.ID, "failed", nil, false, json.RawMessage(`{"code":"upstream_failed","node":"user"}`))
	if err != nil {
		t.Fatal(err)
	}
	if done.Status != "failed" || done.EndedAt == nil || done.Output != nil || string(done.Error) != `{"code": "upstream_failed", "node": "user"}` {
		t.Errorf("finished run = %+v", done)
	}
	if again, err := db.Run(ctx, r.ID); err != nil || again.Status != "failed" || !again.EndedAt.Equal(*done.EndedAt) {
		t.Errorf("Run() = %+v, %v", again, err)
	}
	// A run ends once.
	if _, err := db.FinishRun(ctx, r.ID, "succeeded", json.RawMessage(`1`), false, nil); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("finishing it again: error = %v, want ErrNotFound", err)
	}
}

func TestRun_KeepsTheOutputAndItsFlag(t *testing.T) {
	t.Parallel()
	r := startRun(t, create(t))
	done, err := db.FinishRun(t.Context(), r.ID, "succeeded", json.RawMessage(`"the first 256 KiB"`), true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(done.Output) != `"the first 256 KiB"` || !done.OutputTruncated || done.Error != nil {
		t.Errorf("run = %+v", done)
	}
}

func TestRun_NotFound(t *testing.T) {
	t.Parallel()
	for _, id := range []string{"01890000-0000-7000-8000-000000000000", "not-a-uuid"} {
		if _, err := db.Run(t.Context(), id); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("Run(%q) error = %v, want ErrNotFound", id, err)
		}
	}
}

func TestRuns_PagesNewestFirstPerWorkflow(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	w, other := create(t), create(t)
	var ids []string
	for range 3 {
		ids = append(ids, startRun(t, w).ID)
	}
	startRun(t, other)

	page, err := db.Runs(ctx, w.ID, 2, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != 2 || page[0].ID != ids[2] || page[1].ID != ids[1] {
		t.Fatalf("first page = %+v", page)
	}
	if page[0].Input != nil || page[0].Status != "running" {
		t.Errorf("a listed run = %+v; want no input", page[0])
	}
	page, err = db.Runs(ctx, w.ID, 2, page[1].ID)
	if err != nil || len(page) != 1 || page[0].ID != ids[0] {
		t.Errorf("second page = %+v, %v", page, err)
	}

	all, err := db.Runs(ctx, "", 200, "")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, r := range all {
		seen[r.WorkflowID] = true
	}
	if !seen[w.ID] || !seen[other.ID] {
		t.Errorf("unfiltered list misses a workflow: %v", seen)
	}
}

func TestWorkflowBySlug(t *testing.T) {
	t.Parallel()
	w := create(t)
	got, err := db.WorkflowBySlug(t.Context(), w.Slug)
	if err != nil || got.ID != w.ID {
		t.Errorf("WorkflowBySlug(%q) = %+v, %v", w.Slug, got, err)
	}
	if _, err := db.WorkflowBySlug(t.Context(), "no-such-slug"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("unknown slug: error = %v, want ErrNotFound", err)
	}
}

// Not parallel: it fails every running run in the database, and parallel
// tests only start once the sequential ones are done.
func TestMarkInterrupted(t *testing.T) {
	ctx := t.Context()
	r := startRun(t, create(t))
	n, err := db.MarkInterrupted(ctx)
	if err != nil || n < 1 {
		t.Fatalf("MarkInterrupted() = %d, %v", n, err)
	}
	got, err := db.Run(ctx, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	var e struct{ Code string }
	if err := json.Unmarshal(got.Error, &e); err != nil || got.Status != "failed" || e.Code != "interrupted" || got.EndedAt == nil {
		t.Errorf("interrupted run = %+v, error %s", got, got.Error)
	}
	if n, err := db.MarkInterrupted(ctx); err != nil || n != 0 {
		t.Errorf("second MarkInterrupted() = %d, %v; want 0", n, err)
	}
}
