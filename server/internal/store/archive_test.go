package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/store/storetest"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// other is a second provenance, to tell a later change from the first.
var other = store.Provenance{Actor: "token", Client: "other"}

// calls is a definition whose one node uses revision r of workflow id.
func calls(id string, r int) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": "a", "kind": "http", "uses": map[string]any{"workflow": id, "revision": r}}}})
	return b
}

// both is a definition with a's nodes and b's.
func both(a, b json.RawMessage) json.RawMessage {
	var x, y struct {
		Nodes []json.RawMessage `json:"nodes"`
	}
	_ = json.Unmarshal(a, &x)
	_ = json.Unmarshal(b, &y)
	out, _ := json.Marshal(map[string]any{"nodes": append(x.Nodes, y.Nodes...)})
	return out
}

// saved makes a workflow with defs as its revisions, in order.
func saved(t *testing.T, name string, defs ...json.RawMessage) store.Workflow {
	t.Helper()
	w, _, err := db.CreateWorkflow(t.Context(), slug(t), name, defs[0], person)
	if err != nil {
		t.Fatal(err)
	}
	for i, d := range defs[1:] {
		if _, err := db.SaveRevision(t.Context(), w.ID, i+1, d, person); err != nil {
			t.Fatal(err)
		}
	}
	return w
}

func publish(t *testing.T, id string, revision int) {
	t.Helper()
	if _, err := db.Publish(t.Context(), id, revision, storetest.NoCheck); err != nil {
		t.Fatal(err)
	}
}

// A workflow archived says when, and by what, and leaves the list for the
// archived one; archiving it again changes nothing, and Restore puts it back
// as it was (plan 15).
func TestArchiveWorkflow(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	w := create(t)
	publish(t, w.ID, 1)
	// What's listed is older than this.
	after := create(t)
	listed := func(archived bool) bool {
		ws, err := db.Workflows(ctx, 200, after.ID, archived)
		if err != nil {
			t.Fatal(err)
		}
		return slices.ContainsFunc(ws, func(l store.Workflow) bool { return l.ID == w.ID })
	}
	if !listed(false) || listed(true) {
		t.Errorf("before: listed in use %t, archived %t", listed(false), listed(true))
	}

	got, err := db.ArchiveWorkflow(ctx, w.ID, person)
	if err != nil || got.ArchivedAt == nil || got.ArchivedBy == nil || *got.ArchivedBy != person {
		t.Fatalf("ArchiveWorkflow() = %+v, %v", got, err)
	}
	if listed(false) || !listed(true) {
		t.Errorf("archived: listed in use %t, archived %t", listed(false), listed(true))
	}
	again, err := db.ArchiveWorkflow(ctx, w.ID, other)
	if err != nil || !again.ArchivedAt.Equal(*got.ArchivedAt) || *again.ArchivedBy != person {
		t.Errorf("archiving it again = %+v, %v; want it as it was", again, err)
	}
	if read, err := db.Workflow(ctx, w.ID); err != nil || read.ArchivedAt == nil || *read.ArchivedBy != person {
		t.Errorf("Workflow() = %+v, %v", read, err)
	}

	back, err := db.RestoreWorkflow(ctx, w.ID)
	if err != nil || back.ArchivedAt != nil || back.ArchivedBy != nil || back.PublishedRevision == nil || *back.PublishedRevision != 1 {
		t.Errorf("RestoreWorkflow() = %+v, %v", back, err)
	}
	if !listed(false) || listed(true) {
		t.Errorf("restored: listed in use %t, archived %t", listed(false), listed(true))
	}
	if same, err := db.RestoreWorkflow(ctx, w.ID); err != nil || same.ArchivedAt != nil {
		t.Errorf("restoring it again = %+v, %v", same, err)
	}

	for _, id := range []string{"0190d2a5-0000-7000-8000-000000000000", "not-an-id"} {
		if _, err := db.ArchiveWorkflow(ctx, id, person); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("ArchiveWorkflow(%q) = %v, want ErrNotFound", id, err)
		}
		if _, err := db.RestoreWorkflow(ctx, id); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("RestoreWorkflow(%q) = %v, want ErrNotFound", id, err)
		}
	}
}

func TestArchiveUpstream(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	u, _, err := db.CreateUpstream(ctx, upstreamName(t), upstreamDef(1), person)
	if err != nil {
		t.Fatal(err)
	}
	after, _, err := db.CreateUpstream(ctx, upstreamName(t), upstreamDef(1), person)
	if err != nil {
		t.Fatal(err)
	}
	listed := func(archived bool) bool {
		us, err := db.Upstreams(ctx, 200, after.ID, archived)
		if err != nil {
			t.Fatal(err)
		}
		return slices.ContainsFunc(us, func(l store.Upstream) bool { return l.ID == u.ID })
	}
	got, err := db.ArchiveUpstream(ctx, u.ID, person)
	if err != nil || got.ArchivedAt == nil || *got.ArchivedBy != person {
		t.Fatalf("ArchiveUpstream() = %+v, %v", got, err)
	}
	if listed(false) || !listed(true) {
		t.Errorf("archived: listed in use %t, archived %t", listed(false), listed(true))
	}
	if again, err := db.ArchiveUpstream(ctx, u.ID, other); err != nil || !again.ArchivedAt.Equal(*got.ArchivedAt) || *again.ArchivedBy != person {
		t.Errorf("archiving it again = %+v, %v; want it as it was", again, err)
	}
	// Its versions stay, to read.
	if _, err := db.UpstreamVersion(ctx, u.ID, 1); err != nil {
		t.Errorf("its version 1 = %v", err)
	}
	back, err := db.RestoreUpstream(ctx, u.ID)
	if err != nil || back.ArchivedAt != nil || back.ArchivedBy != nil {
		t.Errorf("RestoreUpstream() = %+v, %v", back, err)
	}
	if !listed(false) || listed(true) {
		t.Errorf("restored: listed in use %t, archived %t", listed(false), listed(true))
	}
	for _, id := range []string{"0190d2a5-0000-7000-8000-000000000000", "not-an-id"} {
		if _, err := db.ArchiveUpstream(ctx, id, person); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("ArchiveUpstream(%q) = %v, want ErrNotFound", id, err)
		}
		if _, err := db.RestoreUpstream(ctx, id); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("RestoreUpstream(%q) = %v, want ErrNotFound", id, err)
		}
	}
}

// An archived constant keeps its value, sealed, with the one before it, and
// its provenance, so Restore brings it all back as it was (plan 15).
func TestArchiveConstant(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	name := constantName(t)
	if _, err := db.CreateConstant(ctx, name, "first", true, person); err != nil {
		t.Fatal(err)
	}
	set, err := db.SetConstant(ctx, name, "second", false, person)
	if err != nil {
		t.Fatal(err)
	}
	got, err := db.ArchiveConstant(ctx, name, other)
	if err != nil || got.ArchivedAt == nil || *got.ArchivedBy != other || got.Provenance != person || !got.UpdatedAt.Equal(set.UpdatedAt) {
		t.Fatalf("ArchiveConstant() = %+v, %v", got, err)
	}
	if again, err := db.ArchiveConstant(ctx, name, person); err != nil || !again.ArchivedAt.Equal(*got.ArchivedAt) || *again.ArchivedBy != other {
		t.Errorf("archiving it again = %+v, %v; want it as it was", again, err)
	}
	// Runs still mask it, so it's still in the list they read.
	all, err := db.Constants(ctx)
	if err != nil {
		t.Fatal(err)
	}
	i := slices.IndexFunc(all, func(c store.Constant) bool { return c.Name == name })
	if i < 0 || all[i].Value != "second" || all[i].ArchivedAt == nil {
		t.Errorf("Constants() holds %d: %+v", i, all)
	}
	back, err := db.RestoreConstant(ctx, name)
	if err != nil || back.ArchivedAt != nil || back.ArchivedBy != nil || back.Value != "second" || !back.HasPrevious {
		t.Errorf("RestoreConstant() = %+v, %v", back, err)
	}
	undone, err := db.UndoConstant(ctx, name, person)
	if err != nil || undone.Value != "first" {
		t.Errorf("the value before it, restored = %+v, %v", undone, err)
	}
	missing := constantName(t)
	if _, err := db.ArchiveConstant(ctx, missing, person); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("ArchiveConstant(missing) = %v, want ErrNotFound", err)
	}
	if _, err := db.RestoreConstant(ctx, missing); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("RestoreConstant(missing) = %v, want ErrNotFound", err)
	}
}

// use is a workflow that uses something, and the revisions that do, as a
// refusal names them.
func use(w store.Workflow, revisions ...int) store.LiveUse {
	return store.LiveUse{ID: w.ID, Name: w.Name, At: revisions}
}

// Archive is refused while a workflow in use uses the thing, at its latest
// or its published revision, directly or through what it pins, however far
// in, and only then, naming the workflows. Each kind of thing, in each place
// (plan 15).
func TestArchive_RefusedWhileLive(t *testing.T) {
	t.Parallel()
	// What a definition that uses each kind is, and how to archive one.
	kinds := []struct {
		name string
		make func(t *testing.T) (json.RawMessage, func() error)
	}{
		{"an upstream", func(t *testing.T) (json.RawMessage, func() error) {
			u, _, err := db.CreateUpstream(t.Context(), upstreamName(t), upstreamDef(1), person)
			if err != nil {
				t.Fatal(err)
			}
			return pins(u.ID, 1), func() error { _, err := db.ArchiveUpstream(t.Context(), u.ID, person); return err }
		}},
		{"a workflow", func(t *testing.T) (json.RawMessage, func() error) {
			w := create(t)
			return calls(w.ID, 1), func() error { _, err := db.ArchiveWorkflow(t.Context(), w.ID, person); return err }
		}},
		{"a constant", func(t *testing.T) (json.RawMessage, func() error) {
			name := constantName(t)
			if _, err := db.CreateConstant(t.Context(), name, "v", false, person); err != nil {
				t.Fatal(err)
			}
			return reads(name), func() error { _, err := db.ArchiveConstant(t.Context(), name, person); return err }
		}},
	}
	// Each stands something up with uses, and says who should refuse.
	places := []struct {
		name  string
		stand func(t *testing.T, uses json.RawMessage) []store.LiveUse
	}{
		{"a latest revision", func(t *testing.T, uses json.RawMessage) []store.LiveUse {
			return []store.LiveUse{use(saved(t, "Orders", def(1), uses), 2)}
		}},
		{"a published revision, older than the latest", func(t *testing.T, uses json.RawMessage) []store.LiveUse {
			w := saved(t, "Orders", uses, def(2))
			publish(t, w.ID, 1)
			return []store.LiveUse{use(w, 1)}
		}},
		{"its latest and its published", func(t *testing.T, uses json.RawMessage) []store.LiveUse {
			w := saved(t, "Orders", uses, def(2), uses)
			publish(t, w.ID, 1)
			return []store.LiveUse{use(w, 1, 3)}
		}},
		{"two workflows, by name", func(t *testing.T, uses json.RawMessage) []store.LiveUse {
			b := saved(t, "Billing", uses)
			a := saved(t, "Accounts", uses)
			return []store.LiveUse{use(a, 1), use(b, 1)}
		}},
		{"through a pin of an old revision", func(t *testing.T, uses json.RawMessage) []store.LiveUse {
			inner := saved(t, "Inner", uses, def(2))
			return []store.LiveUse{use(saved(t, "Caller", calls(inner.ID, 1)), 1)}
		}},
		{"through two pins", func(t *testing.T, uses json.RawMessage) []store.LiveUse {
			inner := saved(t, "Inner", uses, def(2))
			middle := saved(t, "Middle", calls(inner.ID, 1), def(2))
			return []store.LiveUse{use(saved(t, "Caller", calls(middle.ID, 1)), 1)}
		}},
		{"workflows that use each other, as drafts may", func(t *testing.T, uses json.RawMessage) []store.LiveUse {
			b := saved(t, "B", def(1))
			a := saved(t, "A", calls(b.ID, 2))
			if _, err := db.SaveRevision(t.Context(), b.ID, 1, both(calls(a.ID, 1), uses), person); err != nil {
				t.Fatal(err)
			}
			return []store.LiveUse{use(a, 1), use(b, 2)}
		}},
		{"an old revision, neither latest nor published", func(t *testing.T, uses json.RawMessage) []store.LiveUse {
			saved(t, "Orders", uses, def(2))
			return nil
		}},
		{"a pin that doesn't reach it", func(t *testing.T, uses json.RawMessage) []store.LiveUse {
			inner := saved(t, "Inner", uses, def(2))
			saved(t, "Caller", calls(inner.ID, 2))
			return nil
		}},
		{"an archived workflow", func(t *testing.T, uses json.RawMessage) []store.LiveUse {
			w := saved(t, "Orders", uses)
			if _, err := db.ArchiveWorkflow(t.Context(), w.ID, person); err != nil {
				t.Fatal(err)
			}
			return nil
		}},
		{"an archived caller, through a pin", func(t *testing.T, uses json.RawMessage) []store.LiveUse {
			inner := saved(t, "Inner", uses, def(2))
			w := saved(t, "Caller", calls(inner.ID, 1))
			if _, err := db.ArchiveWorkflow(t.Context(), w.ID, person); err != nil {
				t.Fatal(err)
			}
			return nil
		}},
	}
	for _, kind := range kinds {
		for _, place := range places {
			t.Run(kind.name+" in "+place.name, func(t *testing.T) {
				t.Parallel()
				uses, archive := kind.make(t)
				want := place.stand(t, uses)
				err := archive()
				if want == nil {
					if err != nil {
						t.Errorf("archive = %v", err)
					}
					return
				}
				var inUse *store.InUseError
				if !errors.As(err, &inUse) {
					t.Fatalf("archive = %v, want an InUseError", err)
				}
				if got, wanted := fmt.Sprint(inUse.Workflows), fmt.Sprint(want); got != wanted || len(inUse.Upstreams) != 0 {
					t.Errorf("refused for %s, %v; want %s", got, inUse.Upstreams, wanted)
				}
			})
		}
	}
}

// A workflow isn't refused by its own revisions, even one that uses itself,
// as a draft may.
func TestArchiveWorkflow_NotByItself(t *testing.T) {
	t.Parallel()
	w := create(t)
	if _, err := db.SaveRevision(t.Context(), w.ID, 1, calls(w.ID, 1), person); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ArchiveWorkflow(t.Context(), w.ID, person); err != nil {
		t.Errorf("ArchiveWorkflow() = %v", err)
	}
}

// A constant is used by an upstream's latest version too, by a version a
// live workflow pins, and by nothing else: not a version nothing pins, not
// an archived upstream, and not a read of a longer name (plan 15).
func TestArchiveConstant_RefusedByUpstreams(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	archive := func(t *testing.T, name string) (*store.InUseError, error) {
		t.Helper()
		var inUse *store.InUseError
		_, err := db.ArchiveConstant(ctx, name, person)
		if err != nil && !errors.As(err, &inUse) {
			t.Fatal(err)
		}
		return inUse, err
	}
	constant := func(t *testing.T) string {
		t.Helper()
		name := constantName(t)
		if _, err := db.CreateConstant(ctx, name, "v", false, person); err != nil {
			t.Fatal(err)
		}
		return name
	}
	upstream := func(t *testing.T, defs ...json.RawMessage) store.Upstream {
		t.Helper()
		u, _, err := db.CreateUpstream(ctx, upstreamName(t), defs[0], person)
		if err != nil {
			t.Fatal(err)
		}
		for i, d := range defs[1:] {
			if _, err := db.SaveUpstreamVersion(ctx, u.ID, i+1, d, person); err != nil {
				t.Fatal(err)
			}
		}
		return u
	}

	t.Run("its latest version", func(t *testing.T) {
		t.Parallel()
		name := constant(t)
		u := upstream(t, upstreamDef(1), readingUpstream(name))
		inUse, err := archive(t, name)
		if err == nil || len(inUse.Workflows) != 0 || len(inUse.Upstreams) != 1 || inUse.Upstreams[0].ID != u.ID ||
			inUse.Upstreams[0].Name != u.Name || !slices.Equal(inUse.Upstreams[0].At, []int{2}) {
			t.Errorf("archive = %v, %+v", err, inUse)
		}
	})
	t.Run("a version nothing pins", func(t *testing.T) {
		t.Parallel()
		name := constant(t)
		upstream(t, readingUpstream(name), upstreamDef(2))
		if _, err := archive(t, name); err != nil {
			t.Errorf("archive = %v", err)
		}
	})
	t.Run("a version beside the one a live revision pins", func(t *testing.T) {
		t.Parallel()
		name := constant(t)
		u := upstream(t, readingUpstream(name), upstreamDef(2))
		saved(t, "Orders", pins(u.ID, 2))
		if _, err := archive(t, name); err != nil {
			t.Errorf("archive = %v", err)
		}
	})
	t.Run("a version a live revision pins", func(t *testing.T) {
		t.Parallel()
		name := constant(t)
		u := upstream(t, readingUpstream(name), upstreamDef(2))
		w := saved(t, "Orders", pins(u.ID, 1))
		inUse, err := archive(t, name)
		if err == nil || len(inUse.Upstreams) != 0 || len(inUse.Workflows) != 1 || inUse.Workflows[0].ID != w.ID {
			t.Errorf("archive = %v, %+v", err, inUse)
		}
	})
	t.Run("a version pinned through a workflow", func(t *testing.T) {
		t.Parallel()
		name := constant(t)
		u := upstream(t, readingUpstream(name), upstreamDef(2))
		inner := saved(t, "Inner", pins(u.ID, 1), def(2))
		w := saved(t, "Caller", calls(inner.ID, 1))
		inUse, err := archive(t, name)
		if err == nil || len(inUse.Workflows) != 1 || inUse.Workflows[0].ID != w.ID {
			t.Errorf("archive = %v, %+v", err, inUse)
		}
	})
	t.Run("an archived upstream", func(t *testing.T) {
		t.Parallel()
		name := constant(t)
		u := upstream(t, readingUpstream(name))
		if _, err := db.ArchiveUpstream(ctx, u.ID, person); err != nil {
			t.Fatal(err)
		}
		if _, err := archive(t, name); err != nil {
			t.Errorf("archive = %v", err)
		}
	})
	t.Run("a longer name", func(t *testing.T) {
		t.Parallel()
		name := constant(t)
		saved(t, "Orders", reads(name+"_more"))
		upstream(t, readingUpstream(name+"_more"))
		if _, err := archive(t, name); err != nil {
			t.Errorf("archive = %v", err)
		}
	})
}

// Nothing archived changes: each change is refused with ErrArchived, and
// goes through again once it's restored (plan 15).
func TestArchived_RefusesChanges(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	w := saved(t, "Orders", def(1), def(2))
	key, _ := makeKey(t, w, "acme")
	u, _, err := db.CreateUpstream(ctx, upstreamName(t), upstreamDef(1), person)
	if err != nil {
		t.Fatal(err)
	}
	name := constantName(t)
	if _, err := db.CreateConstant(ctx, name, "first", false, person); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetConstant(ctx, name, "second", false, person); err != nil {
		t.Fatal(err)
	}
	for _, archive := range []func() error{
		func() error { _, err := db.ArchiveWorkflow(ctx, w.ID, person); return err },
		func() error { _, err := db.ArchiveUpstream(ctx, u.ID, person); return err },
		func() error { _, err := db.ArchiveConstant(ctx, name, person); return err },
	} {
		if err := archive(); err != nil {
			t.Fatal(err)
		}
	}
	changes := []struct {
		name   string
		change func() error
	}{
		{"a draft", func() error { _, err := db.SaveRevision(ctx, w.ID, 2, def(3), person); return err }},
		{"a publish", func() error { _, err := db.Publish(ctx, w.ID, 2, storetest.NoCheck); return err }},
		{"a new key", func() error { _, err := db.CreateKey(ctx, w.ID, "beta", mint(t), person); return err }},
		{"a rotation", func() error { _, _, err := db.RotateKey(ctx, w.ID, key.ID, 0, mint(t), person); return err }},
		{"a version", func() error { _, err := db.SaveUpstreamVersion(ctx, u.ID, 1, upstreamDef(2), person); return err }},
		{"a value", func() error { _, err := db.SetConstant(ctx, name, "third", false, person); return err }},
		{"an undo", func() error { _, err := db.UndoConstant(ctx, name, person); return err }},
	}
	for _, c := range changes {
		if err := c.change(); !errors.Is(err, store.ErrArchived) {
			t.Errorf("%s of something archived = %v, want ErrArchived", c.name, err)
		}
	}
	for _, restore := range []func() error{
		func() error { _, err := db.RestoreWorkflow(ctx, w.ID); return err },
		func() error { _, err := db.RestoreUpstream(ctx, u.ID); return err },
		func() error { _, err := db.RestoreConstant(ctx, name); return err },
	} {
		if err := restore(); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range changes {
		// The key was revoked with the workflow, for good.
		if err := c.change(); err != nil && !errors.Is(err, store.ErrKeyNotActive) {
			t.Errorf("%s once restored = %v", c.name, err)
		}
	}
}

// Archiving a workflow revokes its keys, one rotated and still working
// among them, so its URL stops answering at once; one past its expiry stays
// expired, and a run a key started keeps its name. Restore brings none back,
// and a new one serves (plan 15).
func TestArchiveWorkflow_RevokesKeys(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	w := create(t)
	active, activeKey := makeKey(t, w, "active")
	rotated, rotatedKey := makeKey(t, w, "rotated")
	replaced, oldKey, err := db.RotateKey(ctx, w.ID, rotated.ID, time.Hour, mint(t), person)
	if err != nil {
		t.Fatal(err)
	}
	gone, goneKey := makeKey(t, w, "gone")
	if _, _, err := db.RotateKey(ctx, w.ID, gone.ID, 0, mint(t), person); err != nil {
		t.Fatal(err)
	}
	if !serves(t, w.Slug, activeKey) || !serves(t, w.Slug, rotatedKey) || serves(t, w.Slug, goneKey) {
		t.Fatal("the keys don't stand as they should")
	}

	if _, err := db.ArchiveWorkflow(ctx, w.ID, person); err != nil {
		t.Fatal(err)
	}
	if serves(t, w.Slug, activeKey) || serves(t, w.Slug, rotatedKey) {
		t.Error("a key serves an archived workflow")
	}
	keys, err := db.Keys(ctx, w.ID)
	if err != nil {
		t.Fatal(err)
	}
	status := map[string]string{}
	for _, k := range keys {
		status[k.ID] = k.Status
	}
	if status[active.ID] != "revoked" || status[oldKey.ID] != "revoked" || status[replaced.ID] != "revoked" || status[gone.ID] != "expired" {
		t.Errorf("the keys stand %v", status)
	}

	if _, err := db.RestoreWorkflow(ctx, w.ID); err != nil {
		t.Fatal(err)
	}
	if serves(t, w.Slug, activeKey) || serves(t, w.Slug, rotatedKey) {
		t.Error("Restore brought a key back")
	}
	if _, fresh := makeKey(t, w, "fresh"); !serves(t, w.Slug, fresh) {
		t.Error("a new key doesn't serve the restored workflow")
	}
}

// A name stays taken while what has it is archived, and making one with it
// says so, apart from a name taken by something in use (plan 15).
func TestArchived_NamesStayTaken(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	w := create(t)
	u, _, err := db.CreateUpstream(ctx, upstreamName(t), upstreamDef(1), person)
	if err != nil {
		t.Fatal(err)
	}
	name := constantName(t)
	if _, err := db.CreateConstant(ctx, name, "v", false, person); err != nil {
		t.Fatal(err)
	}
	makes := []func() error{
		func() error { _, _, err := db.CreateWorkflow(ctx, w.Slug, "again", def(1), person); return err },
		func() error { _, _, err := db.CreateUpstream(ctx, u.Name, upstreamDef(1), person); return err },
		func() error { _, err := db.CreateConstant(ctx, name, "v", false, person); return err },
	}
	for i, m := range makes {
		if err := m(); !errors.Is(err, store.ErrConflict) || errors.Is(err, store.ErrArchivedName) {
			t.Errorf("%d: a name in use = %v, want ErrConflict alone", i, err)
		}
	}
	if _, err := db.ArchiveWorkflow(ctx, w.ID, person); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ArchiveUpstream(ctx, u.ID, person); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ArchiveConstant(ctx, name, person); err != nil {
		t.Fatal(err)
	}
	for i, m := range makes {
		if err := m(); !errors.Is(err, store.ErrArchivedName) || !errors.Is(err, store.ErrConflict) {
			t.Errorf("%d: an archived name = %v, want ErrArchivedName, an ErrConflict", i, err)
		}
	}
}

// What a definition uses says what's archived, however far in, by name, and
// which constants each version and revision reads (plan 15).
func TestDeps_Archived(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	gone, kept := constantName(t), constantName(t)
	for _, name := range []string{gone, kept} {
		if _, err := db.CreateConstant(ctx, name, "v", false, person); err != nil {
			t.Fatal(err)
		}
	}
	retired, _, err := db.CreateUpstream(ctx, upstreamName(t), readingUpstream(gone), person)
	if err != nil {
		t.Fatal(err)
	}
	inUse, _, err := db.CreateUpstream(ctx, upstreamName(t), upstreamDef(1), person)
	if err != nil {
		t.Fatal(err)
	}
	inner := saved(t, "Inner", json.RawMessage(`{"nodes": [
	    {"id": "a", "kind": "http", "uses": {"upstream": "`+retired.ID+`", "version": 1}},
	    {"id": "b", "kind": "http", "uses": {"upstream": "`+inUse.ID+`", "version": 1}},
	    {"id": "c", "kind": "transform", "expr": "$const.`+kept+`", "when": "$const.`+kept+`_more"}]}`))
	caller := saved(t, "Caller", calls(inner.ID, 1))
	if _, err := db.ArchiveWorkflow(ctx, caller.ID, person); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ArchiveWorkflow(ctx, inner.ID, person); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ArchiveUpstream(ctx, retired.ID, person); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ArchiveUpstream(ctx, inUse.ID, person); err != nil {
		t.Fatal(err)
	}
	if _, err := db.RestoreUpstream(ctx, inUse.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ArchiveConstant(ctx, gone, person); err != nil {
		t.Fatal(err)
	}

	deps, err := db.Deps(ctx, &workflow.Definition{Nodes: []workflow.Node{{ID: "n", Uses: &workflow.Uses{Workflow: inner.ID, Revision: 1}}}})
	if err != nil {
		t.Fatal(err)
	}
	if want := map[string]string{retired.ID: retired.Name, inner.ID: "Inner"}; fmt.Sprint(deps.Archived) != fmt.Sprint(want) {
		t.Errorf("Archived = %v, want %v", deps.Archived, want)
	}
	if live, ok := deps.Constants[gone]; !ok || live {
		t.Errorf("Constants[gone] = %t, %t", live, ok)
	}
	if live, ok := deps.Constants[kept]; !ok || !live {
		t.Errorf("Constants[kept] = %t, %t", live, ok)
	}
	want := []string{kept, kept + "_more"}
	slices.Sort(want)
	if got := deps.Reads[workflow.Uses{Workflow: inner.ID, Revision: 1}]; !slices.Equal(got, want) {
		t.Errorf("what Inner reads = %v, want %v", got, want)
	}
	if got := deps.Reads[workflow.Uses{Upstream: retired.ID, Version: 1}]; !slices.Equal(got, []string{gone}) {
		t.Errorf("what the upstream reads = %v, want %v", got, gone)
	}
}

// Publish checks a revision, given what it uses, and something it finds
// stops the publish; it's as the check saw it (plan 15).
func TestPublish_Checks(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	u, _, err := db.CreateUpstream(ctx, upstreamName(t), upstreamDef(1), person)
	if err != nil {
		t.Fatal(err)
	}
	w := saved(t, "Orders", pins(u.ID, 1), def(2))
	wrong := errors.New("it has problems")
	var checked *workflow.Definition
	var deps workflow.Deps
	_, err = db.Publish(ctx, w.ID, 1, func(d *workflow.Definition, ds workflow.Deps) error {
		checked, deps = d, ds
		return wrong
	})
	if !errors.Is(err, wrong) {
		t.Errorf("Publish() = %v, want the check's error", err)
	}
	if checked == nil || len(checked.Nodes) != 1 || deps.Versions[workflow.Uses{Upstream: u.ID, Version: 1}] == nil {
		t.Errorf("the check was given %+v, %+v", checked, deps)
	}
	if got, _ := db.Workflow(ctx, w.ID); got.PublishedRevision != nil {
		t.Errorf("published %d, though the check refused it", *got.PublishedRevision)
	}
}

// waitUntil polls conn until query finds a row, as a lock another
// transaction waits for shows in pg_locks.
func waitUntil(t *testing.T, conn *pgx.Conn, what, query string) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		var waiting int
		if err := conn.QueryRow(t.Context(), query).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal(what)
		}
	}
}

// An archive that comes while a publish is checking waits for it, and then
// sees what it put live: no revision goes live using what's just been
// archived (plan 15). Not parallel: anything else archiving would muddle
// who's waiting.
func TestArchive_WaitsForAPublish(t *testing.T) {
	ctx := t.Context()
	u, _, err := db.CreateUpstream(ctx, upstreamName(t), upstreamDef(1), person)
	if err != nil {
		t.Fatal(err)
	}
	// Revision 1 pins it and isn't live until it's published.
	w := saved(t, "Orders", pins(u.ID, 1), def(2))
	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	done := make(chan error, 1)
	_, err = db.Publish(ctx, w.ID, 1, func(*workflow.Definition, workflow.Deps) error {
		go func() {
			_, err := db.ArchiveUpstream(context.Background(), u.ID, person)
			done <- err
		}()
		waitUntil(t, conn, "the archive didn't wait for the publish", `SELECT count(*) FROM pg_locks l JOIN pg_database d ON d.oid = l.database
			WHERE NOT l.granted AND l.locktype = 'advisory' AND d.datname = current_database()`)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var inUse *store.InUseError
	if err := <-done; !errors.As(err, &inUse) || len(inUse.Workflows) != 1 || inUse.Workflows[0].ID != w.ID {
		t.Errorf("ArchiveUpstream() during a publish that uses it = %v, want an InUseError", err)
	}
}

// A key made while its workflow is being archived waits, and is refused:
// nothing may have a working key once the archive has revoked them all.
func TestCreateKey_WaitsForAnArchive(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
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
	// An archive, not yet committed, as ArchiveWorkflow locks and marks it.
	if _, err := tx.Exec(ctx, `UPDATE workflows SET archived_at = now(), archived_by = $2 WHERE id = $1::uuid`, w.ID, person); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := db.CreateKey(context.Background(), w.ID, "acme", mint(t), person)
		done <- err
	}()
	waitUntil(t, conn, "the key didn't wait for the archive", `SELECT count(*) FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))`)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, store.ErrArchived) {
		t.Errorf("CreateKey() during an archive = %v, want ErrArchived", err)
	}
}
