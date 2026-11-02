package store_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"testing"

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
func TestVersions(t *testing.T) {
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
	vs, err := db.Versions(ctx, d)
	if err != nil {
		t.Fatal(err)
	}
	if v, ok := vs[workflow.Uses{Upstream: u.ID, Version: 2}]; len(vs) != 1 || !ok || v.Request.URL != "https://users.example.com/v1" {
		t.Errorf("Versions() = %v", vs)
	}
	if none, err := db.Versions(ctx, &workflow.Definition{}); err != nil || len(none) != 0 {
		t.Errorf("Versions() of no uses = %v, %v", none, err)
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
	if _, err := db.SaveRevision(ctx, d.ID, 1, uses(1), person); err != nil {
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
