package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// upstreamDef is a version of an upstream, numbered n so versions differ.
func upstreamDef(n int) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"request": map[string]any{"method": "GET", "url": "https://users.example.com/v1"}, "n": n})
	return b
}

// An upstream's name is unique, so each test's own.
func upstreamName(t *testing.T) string {
	t.Helper()
	return "Users " + slug(t)
}

// Every save of an upstream is a version of its own, which never changes
// (plan 07), and a save names the version it builds on.
func TestUpstreams_Versions(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	name := upstreamName(t)
	u, v1, err := db.CreateUpstream(ctx, name, upstreamDef(1), person)
	if err != nil {
		t.Fatal(err)
	}
	if len(u.ID) != 36 || u.Name != name || u.LatestVersion != 1 || v1.UpstreamID != u.ID || v1.Version != 1 ||
		v1.Provenance != person || string(v1.Definition) != `{"n": 1, "request": {"url": "https://users.example.com/v1", "method": "GET"}}` {
		t.Errorf("created %+v, version %+v %s", u, v1, v1.Definition)
	}

	v2, err := db.SaveUpstreamVersion(ctx, u.ID, 1, upstreamDef(2), person)
	if err != nil || v2.Version != 2 {
		t.Fatalf("SaveUpstreamVersion() = %+v, %v", v2, err)
	}
	if _, err := db.SaveUpstreamVersion(ctx, u.ID, 1, upstreamDef(3), person); !errors.Is(err, store.ErrVersionMismatch) {
		t.Errorf("a save on version 1, after 2: %v, want ErrVersionMismatch", err)
	}
	// A save that changes nothing makes no version: version 2 is the
	// answer, as it was, whoever saves. Key order and spacing don't count;
	// on a stale base, it's refused all the same.
	same, err := db.SaveUpstreamVersion(ctx, u.ID, 2, json.RawMessage(`{"request": {"url": "https://users.example.com/v1", "method": "GET"}, "n": 2}`),
		store.Provenance{Actor: "token", Client: "other"})
	if err != nil || same.Version != 2 || same.Provenance != person {
		t.Errorf("a save that changes nothing = %+v, %v; want version 2, as it was", same, err)
	}
	if _, err := db.SaveUpstreamVersion(ctx, u.ID, 1, upstreamDef(1), person); !errors.Is(err, store.ErrVersionMismatch) {
		t.Errorf("a save of version 1 as it was, after 2: %v, want ErrVersionMismatch", err)
	}
	if got, err := db.Upstream(ctx, u.ID); err != nil || got.LatestVersion != 2 {
		t.Errorf("Upstream() = %+v, %v; want version 2 the latest", got, err)
	}
	// Version 1 is as it was.
	if got, err := db.UpstreamVersion(ctx, u.ID, 1); err != nil || string(got.Definition) != string(v1.Definition) {
		t.Errorf("UpstreamVersion(1) = %s, %v", got.Definition, err)
	}
	if _, err := db.UpstreamVersion(ctx, u.ID, 3); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("UpstreamVersion(3): %v, want ErrNotFound", err)
	}
	if _, err := db.SaveUpstreamVersion(ctx, "01a1a1a1-0000-7000-8000-000000000000", 1, upstreamDef(1), person); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("a save of no upstream: %v, want ErrNotFound", err)
	}
}

// A definition's upstreams come from the library in one go, decoded; one
// it doesn't have is left out.
func TestDeps_Versions(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	u, _, err := db.CreateUpstream(ctx, upstreamName(t), upstreamDef(1), person)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SaveUpstreamVersion(ctx, u.ID, 1, upstreamDef(2), person); err != nil {
		t.Fatal(err)
	}
	d := &workflow.Definition{Nodes: []workflow.Node{
		{ID: "a", Uses: &workflow.Uses{Upstream: u.ID, Version: 2}},
		{ID: "b", Uses: &workflow.Uses{Upstream: u.ID, Version: 9}},
		{ID: "c", Uses: &workflow.Uses{Upstream: "not-an-id", Version: 1}},
		{ID: "d"},
	}}
	deps, err := db.Deps(ctx, d)
	if err != nil {
		t.Fatal(err)
	}
	vs := deps.Versions
	if v, ok := vs[workflow.Uses{Upstream: u.ID, Version: 2}]; len(vs) != 1 || !ok || v.Request.URL != "https://users.example.com/v1" {
		t.Errorf("Deps().Versions = %v", vs)
	}
	if none, err := db.Deps(ctx, &workflow.Definition{}); err != nil || len(none.Versions) != 0 || len(none.Revisions) != 0 {
		t.Errorf("Deps() of no uses = %v, %v", none, err)
	}
}

// The workflow revisions a definition uses come with what they use in
// turn, an upstream's version among them, each once, though a revision
// uses the one that uses it.
func TestDeps_Revisions(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	u, _, err := db.CreateUpstream(ctx, upstreamName(t), upstreamDef(1), person)
	if err != nil {
		t.Fatal(err)
	}
	inner, _, err := db.CreateWorkflow(ctx, slug(t), "inner", json.RawMessage(`{"nodes": [{"id": "call", "kind": "http", "uses": {"upstream": "`+u.ID+`", "version": 1}}]}`), person)
	if err != nil {
		t.Fatal(err)
	}
	outer, _, err := db.CreateWorkflow(ctx, slug(t), "outer", json.RawMessage(`{"nodes": [{"id": "in", "kind": "http", "uses": {"workflow": "`+inner.ID+`", "revision": 1}}]}`), person)
	if err != nil {
		t.Fatal(err)
	}
	// inner's second revision uses outer, as a draft may.
	if _, err := db.SaveRevision(ctx, inner.ID, 1, json.RawMessage(`{"nodes": [{"id": "back", "kind": "http", "uses": {"workflow": "`+outer.ID+`", "revision": 1}}]}`), person); err != nil {
		t.Fatal(err)
	}
	d := &workflow.Definition{Nodes: []workflow.Node{
		{ID: "a", Uses: &workflow.Uses{Workflow: outer.ID, Revision: 1}},
		{ID: "b", Uses: &workflow.Uses{Workflow: inner.ID, Revision: 2}},
		{ID: "c", Uses: &workflow.Uses{Workflow: "not-an-id", Revision: 1}},
	}}
	deps, err := db.Deps(ctx, d)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for ref := range deps.Revisions {
		switch ref.Workflow {
		case outer.ID:
			got = append(got, fmt.Sprintf("outer %d", ref.Revision))
		case inner.ID:
			got = append(got, fmt.Sprintf("inner %d", ref.Revision))
		default:
			got = append(got, ref.Workflow)
		}
	}
	slices.Sort(got)
	if strings.Join(got, ", ") != "inner 1, inner 2, outer 1" || len(deps.Versions) != 1 {
		t.Errorf("Deps() = revisions %v, versions %v", got, deps.Versions)
	}
	if d := deps.Revisions[workflow.Uses{Workflow: inner.ID, Revision: 1}]; d == nil || d.Nodes[0].ID != "call" {
		t.Errorf("inner 1 = %+v", d)
	}
}

// Who uses an upstream: each workflow whose latest revision has a node that
// does, the versions those nodes pin, and whether that revision is served.
func TestUpstreamUsers(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	u, _, err := db.CreateUpstream(ctx, upstreamName(t), upstreamDef(1), person)
	if err != nil {
		t.Fatal(err)
	}
	uses := func(versions ...int) json.RawMessage {
		var nodes []map[string]any
		for i, v := range versions {
			nodes = append(nodes, map[string]any{"id": fmt.Sprintf("n%d", i), "kind": "http", "uses": map[string]any{"upstream": u.ID, "version": v}})
		}
		b, _ := json.Marshal(map[string]any{"nodes": nodes})
		return b
	}
	// a uses versions 2 and 1 in its latest revision, published; b used it
	// in revision 1 only; c never did; d uses it in both its revisions, the
	// first published.
	a, _, err := db.CreateWorkflow(ctx, slug(t), "a", uses(2, 1, 2), person)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Publish(ctx, a.ID, 1); err != nil {
		t.Fatal(err)
	}
	b, _, err := db.CreateWorkflow(ctx, slug(t), "b", uses(1), person)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SaveRevision(ctx, b.ID, 1, uses(), person); err != nil {
		t.Fatal(err)
	}
	if _, _, err := db.CreateWorkflow(ctx, slug(t), "c", def(1), person); err != nil {
		t.Fatal(err)
	}
	d, _, err := db.CreateWorkflow(ctx, slug(t), "d", uses(1), person)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Publish(ctx, d.ID, 1); err != nil {
		t.Fatal(err)
	}
	// A second node, as a save that changes nothing makes no revision.
	if _, err := db.SaveRevision(ctx, d.ID, 1, uses(1, 1), person); err != nil {
		t.Fatal(err)
	}
	got, err := db.UpstreamUsers(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Newest first, as workflow ids are UUIDv7s.
	if len(got) != 2 || got[1].WorkflowID != a.ID || got[1].Name != "a" || got[1].Revision != 1 ||
		!slices.Equal(got[1].Versions, []int{1, 2}) || !got[1].Published ||
		got[0].WorkflowID != d.ID || got[0].Revision != 2 || got[0].Published {
		t.Errorf("UpstreamUsers() = %+v", got)
	}
}

func TestUpstreams_ANameIsTakenOnce(t *testing.T) {
	t.Parallel()
	name := upstreamName(t)
	if _, _, err := db.CreateUpstream(t.Context(), name, upstreamDef(1), person); err != nil {
		t.Fatal(err)
	}
	if _, _, err := db.CreateUpstream(t.Context(), name, upstreamDef(1), person); !errors.Is(err, store.ErrConflict) {
		t.Errorf("a second %q: %v, want ErrConflict", name, err)
	}
}

// The library lists upstreams newest first, a page at a time. Other tests
// make upstreams meanwhile, so it checks order and the cursor rather than
// exact contents.
func TestUpstreams_PagesNewestFirst(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	for range 3 {
		if _, _, err := db.CreateUpstream(ctx, upstreamName(t), upstreamDef(1), person); err != nil {
			t.Fatal(err)
		}
	}
	first, err := db.Upstreams(ctx, 2, "")
	if err != nil || len(first) != 2 || first[0].ID <= first[1].ID {
		t.Fatalf("Upstreams(2) = %+v, %v; want two, newest first", first, err)
	}
	next, err := db.Upstreams(ctx, 2, first[1].ID)
	if err != nil || len(next) == 0 || next[0].ID >= first[1].ID {
		t.Errorf("the page after %s = %+v, %v", first[1].ID, next, err)
	}
}

// pins is a definition whose one node pins version v of upstream id.
func pins(id string, v int) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": "a", "kind": "http", "uses": map[string]any{"upstream": id, "version": v}}}})
	return b
}

// An upstream no saved revision pins is deleted with every version. One a
// revision pins is refused, naming the workflows and revisions, however old
// the revision and whether or not it's served (plan 07).
func TestDeleteUpstream(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	unused, _, err := db.CreateUpstream(ctx, upstreamName(t), upstreamDef(1), person)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SaveUpstreamVersion(ctx, unused.ID, 1, upstreamDef(2), person); err != nil {
		t.Fatal(err)
	}
	if err := db.DeleteUpstream(ctx, unused.ID); err != nil {
		t.Fatalf("DeleteUpstream() of one nothing pins = %v", err)
	}
	if _, err := db.UpstreamVersion(ctx, unused.ID, 2); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("its version 2 after the delete: %v, want ErrNotFound", err)
	}
	for _, id := range []string{unused.ID, "not-an-id"} {
		if err := db.DeleteUpstream(ctx, id); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("DeleteUpstream(%q) = %v, want ErrNotFound", id, err)
		}
	}

	// Revision 1 pins it, 2 moved off it, and 3 pins it again.
	used, _, err := db.CreateUpstream(ctx, upstreamName(t), upstreamDef(1), person)
	if err != nil {
		t.Fatal(err)
	}
	w, _, err := db.CreateWorkflow(ctx, slug(t), "Orders", pins(used.ID, 1), person)
	if err != nil {
		t.Fatal(err)
	}
	for base, d := range []json.RawMessage{def(2), pins(used.ID, 1)} {
		if _, err := db.SaveRevision(ctx, w.ID, base+1, d, person); err != nil {
			t.Fatal(err)
		}
	}
	var inUse *store.InUseError
	err = db.DeleteUpstream(ctx, used.ID)
	if !errors.As(err, &inUse) || len(inUse.Pins) != 1 || inUse.Pins[0].WorkflowID != w.ID || inUse.Pins[0].Name != "Orders" ||
		!slices.Equal(inUse.Pins[0].Revisions, []int{1, 3}) {
		t.Errorf("DeleteUpstream() of one revisions pin = %v", err)
	}
	if _, err := db.Upstream(ctx, used.ID); err != nil {
		t.Errorf("after a refused delete: %v", err)
	}
}

// A revision saved while a delete checks is waited for, and then seen: no
// revision can pin an upstream that's gone.
func TestDeleteUpstream_ASaveInBetween(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	u, _, err := db.CreateUpstream(ctx, upstreamName(t), upstreamDef(1), person)
	if err != nil {
		t.Fatal(err)
	}
	w := create(t)
	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// A save of a revision that pins it, not yet committed.
	if _, err := tx.Exec(ctx, `INSERT INTO workflow_revisions (workflow_id, revision, definition, provenance)
		VALUES ($1::uuid, 2, $2, $3)`, w.ID, pins(u.ID, 1), person); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- db.DeleteUpstream(context.Background(), u.ID) }()
	// Once a delete waits for the save, the save commits.
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		var waiting int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM pg_locks
			WHERE NOT granted AND mode = 'ShareLock' AND relation = 'workflow_revisions'::regclass`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the delete didn't wait for the save")
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var inUse *store.InUseError
	if err := <-done; !errors.As(err, &inUse) {
		t.Errorf("DeleteUpstream() during a save that pins it = %v, want an InUseError", err)
	}
}
