package store_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// listOf is workflow id's changes, active ones or its history, newest first.
func listOf(t *testing.T, id string, history bool) []store.Change {
	t.Helper()
	cs, err := db.WorkflowChanges(t.Context(), id, history, 200, "")
	if err != nil {
		t.Fatal(err)
	}
	return cs
}

// said is changes as "kind state", one each, newest first.
func said(cs []store.Change) string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.Kind + " " + c.State
	}
	return strings.Join(out, ", ")
}

// active is how many of workflow id's changes are active, as its record
// says.
func active(t *testing.T, id string) int {
	t.Helper()
	w, err := db.Workflow(t.Context(), id)
	if err != nil {
		t.Fatal(err)
	}
	return w.ActiveChanges
}

// A constant's change goes on the list of each workflow that reads it now,
// directly or through what it pins, and no other; it never holds the value,
// and it's active until it's dismissed (plan 16).
func TestChanges_AConstantChanged(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	name := constantName(t)
	const value = "sk_live_changes_0123456789"
	if _, err := db.CreateConstant(ctx, name, "first", false, person); err != nil {
		t.Fatal(err)
	}
	latest := saved(t, "Latest", reads(name))
	served := saved(t, "Served", reads(name), def(2))
	publish(t, served.ID, 1)
	old := saved(t, "Old", reads(name), def(2))
	retired := saved(t, "Retired", reads(name))
	if _, err := db.ArchiveWorkflow(ctx, retired.ID, person); err != nil {
		t.Fatal(err)
	}
	u, _, err := db.CreateUpstream(ctx, upstreamName(t), readingUpstream(name), person)
	if err != nil {
		t.Fatal(err)
	}
	through := saved(t, "Through", pins(u.ID, 1))

	if _, err := db.SetConstant(ctx, name, value, false, other); err != nil {
		t.Fatal(err)
	}
	for _, w := range []store.Workflow{latest, served, through} {
		cs := listOf(t, w.ID, false)
		if said(cs) != "constant_changed active" || active(t, w.ID) != 1 {
			t.Fatalf("%s's changes = %s, %d active", w.Name, said(cs), active(t, w.ID))
		}
		c := cs[0]
		if c.Subject != "constant" || c.SubjectID != name || c.Detail.Name != name || c.Detail.How != "set" || c.Provenance != other {
			t.Errorf("%s's change = %+v", w.Name, c)
		}
	}
	for _, w := range []store.Workflow{old, retired} {
		if cs := listOf(t, w.ID, false); len(cs) != 0 {
			t.Errorf("%s, which doesn't read it now, was told: %s", w.Name, said(cs))
		}
	}
	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var kept string
	if err := conn.QueryRow(ctx, `SELECT COALESCE(string_agg(detail::text || provenance::text, ''), '') FROM changes WHERE subject_id = $1`, name).Scan(&kept); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(kept, value) || strings.Contains(kept, "first") {
		t.Errorf("a change holds a value: %s", kept)
	}

	// The same value again changes nothing, so it isn't recorded.
	if _, err := db.SetConstant(ctx, name, value, false, other); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetConstant(ctx, name, value, true, other); err != nil {
		t.Fatal(err)
	}
	if _, err := db.UndoConstant(ctx, name, person); err != nil {
		t.Fatal(err)
	}
	cs := listOf(t, latest.ID, false)
	if said(cs) != "constant_changed active, constant_changed active, constant_changed active" ||
		cs[0].Detail.How != "undone" || cs[1].Detail.How != "made_secret" || cs[2].Detail.How != "set" {
		t.Errorf("Latest's changes = %s: %+v", said(cs), cs)
	}

	// Dismissed, it's history, for that workflow alone, and saying so; again,
	// it stays as it was.
	gone, err := db.DismissChange(ctx, latest.ID, cs[2].ID, other)
	if err != nil || gone.State != "dismissed" || gone.DismissedAt == nil || *gone.DismissedBy != other {
		t.Fatalf("DismissChange() = %+v, %v", gone, err)
	}
	again, err := db.DismissChange(ctx, latest.ID, cs[2].ID, person)
	if err != nil || !again.DismissedAt.Equal(*gone.DismissedAt) || *again.DismissedBy != other {
		t.Errorf("dismissing it again = %+v, %v; want it as it was", again, err)
	}
	if got := said(listOf(t, latest.ID, true)); got != "constant_changed dismissed" {
		t.Errorf("Latest's history = %s", got)
	}
	if active(t, latest.ID) != 2 || active(t, served.ID) != 3 {
		t.Errorf("active: Latest %d, Served %d; want 2 and 3", active(t, latest.ID), active(t, served.ID))
	}
	for _, tt := range []struct{ workflow, change string }{
		{served.ID, "0190d2a5-0000-7000-8000-000000000000"},
		{old.ID, cs[0].ID},
		{latest.ID, "not-an-id"},
	} {
		if _, err := db.DismissChange(ctx, tt.workflow, tt.change, person); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("DismissChange(%s, %s) = %v, want ErrNotFound", tt.workflow, tt.change, err)
		}
	}
	if _, err := db.WorkflowChanges(ctx, "0190d2a5-0000-7000-8000-000000000000", false, 10, ""); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("WorkflowChanges(none) = %v, want ErrNotFound", err)
	}
}

// A new version of an upstream goes on the list of each workflow whose
// latest or published revision pins an older one. It's active while the
// latest revision does, so a save that moves the step up deals with it, and
// moving back makes it active again (plan 16).
func TestChanges_ANewerVersion(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	u, _, err := db.CreateUpstream(ctx, upstreamName(t), upstreamDef(1), person)
	if err != nil {
		t.Fatal(err)
	}
	using := saved(t, "Using", pins(u.ID, 1))
	served := saved(t, "Served", pins(u.ID, 1), def(2))
	publish(t, served.ID, 1)
	untouched := saved(t, "Untouched", def(1))
	retired := saved(t, "Retired", pins(u.ID, 1))
	if _, err := db.ArchiveWorkflow(ctx, retired.ID, person); err != nil {
		t.Fatal(err)
	}

	if _, err := db.SaveUpstreamVersion(ctx, u.ID, 1, upstreamDef(2), other); err != nil {
		t.Fatal(err)
	}
	cs := listOf(t, using.ID, false)
	if said(cs) != "upstream_version active" || cs[0].SubjectID != u.ID || cs[0].Detail.Version != 2 || cs[0].Detail.Name != u.Name || cs[0].Provenance != other {
		t.Fatalf("Using's changes = %s: %+v", said(cs), cs)
	}
	// Served's latest revision uses it no more: publishing that is what's
	// left, and the editor says so.
	if got := said(listOf(t, served.ID, true)); got != "upstream_version done" {
		t.Errorf("Served's history = %s", got)
	}
	if got := said(listOf(t, untouched.ID, true)); got != "" {
		t.Errorf("Untouched was told: %s", got)
	}
	if got := said(listOf(t, retired.ID, false)); got != "" {
		t.Errorf("Retired, archived, was told: %s", got)
	}

	if _, err := db.SaveRevision(ctx, using.ID, 1, pins(u.ID, 2), person); err != nil {
		t.Fatal(err)
	}
	if got := said(listOf(t, using.ID, true)); got != "upstream_version done" || active(t, using.ID) != 0 {
		t.Errorf("moved up, Using's history = %s, %d active", got, active(t, using.ID))
	}
	if _, err := db.SaveRevision(ctx, using.ID, 2, pins(u.ID, 1), person); err != nil {
		t.Fatal(err)
	}
	if got := said(listOf(t, using.ID, false)); got != "upstream_version active" {
		t.Errorf("moved back, Using's changes = %s", got)
	}
}

// A workflow publishing a revision goes on the list of each workflow that
// pins an older revision of it, but not its own, though a draft of it pins
// one, and not one that pins the revision itself; and publishing the
// revision it serves records nothing (plan 16).
func TestChanges_ANewerRevision(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	billing := saved(t, "Billing", def(1))
	publish(t, billing.ID, 1)
	caller := saved(t, "Caller", calls(billing.ID, 1))
	ahead := saved(t, "Ahead", calls(billing.ID, 2))
	if _, err := db.SaveRevision(ctx, billing.ID, 1, calls(billing.ID, 1), person); err != nil {
		t.Fatal(err)
	}
	publish(t, billing.ID, 2)
	publish(t, billing.ID, 2)
	cs := listOf(t, caller.ID, false)
	if said(cs) != "workflow_published active" || cs[0].SubjectID != billing.ID || cs[0].Detail.Revision != 2 || cs[0].Detail.Name != "Billing" {
		t.Fatalf("Caller's changes = %s: %+v", said(cs), cs)
	}
	if got := said(listOf(t, billing.ID, false)) + said(listOf(t, billing.ID, true)); got != "" {
		t.Errorf("Billing was told of its own publish: %s", got)
	}
	if got := said(listOf(t, ahead.ID, true)); got != "" {
		t.Errorf("Ahead, which pins revision 2, was told: %s", got)
	}
	if _, err := db.SaveRevision(ctx, caller.ID, 1, calls(billing.ID, 2), person); err != nil {
		t.Fatal(err)
	}
	if got := said(listOf(t, caller.ID, true)); got != "workflow_published done" {
		t.Errorf("moved up, Caller's history = %s", got)
	}
}

// A key made, rotated or revoked goes on its workflow's list. A rotation is
// active while the old key works, so it's done at its expiry, once the old
// key is revoked, or at once when rotated with none; the rest is history
// (plan 16).
func TestChanges_Keys(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	w := create(t)
	k, _ := makeKey(t, w, "Mobile app")
	if got := said(listOf(t, w.ID, true)); got != "key_made done" {
		t.Fatalf("history = %s", got)
	}
	// What isn't active stays as it is.
	if c, err := db.DismissChange(ctx, w.ID, listOf(t, w.ID, true)[0].ID, person); err != nil || c.State != "done" || c.DismissedAt != nil {
		t.Errorf("dismissing what's done = %+v, %v", c, err)
	}
	made, old, err := db.RotateKey(ctx, w.ID, k.ID, time.Hour, mint(t), other)
	if err != nil {
		t.Fatal(err)
	}
	cs := listOf(t, w.ID, false)
	if said(cs) != "key_rotated active" || cs[0].SubjectID != old.ID || cs[0].Detail.Name != "Mobile app" || cs[0].Detail.Prefix != old.Prefix ||
		cs[0].Detail.ExpiresAt == nil || !cs[0].Detail.ExpiresAt.Equal(*old.ExpiresAt) {
		t.Fatalf("changes = %s: %+v", said(cs), cs)
	}
	if _, err := db.RevokeKey(ctx, w.ID, old.ID, person); err != nil {
		t.Fatal(err)
	}
	// Revoked already, it records nothing more.
	if _, err := db.RevokeKey(ctx, w.ID, old.ID, person); err != nil {
		t.Fatal(err)
	}
	if got := said(listOf(t, w.ID, true)); got != "key_revoked done, key_rotated done, key_made done" {
		t.Errorf("revoked, the history = %s", got)
	}
	if _, _, err := db.RotateKey(ctx, w.ID, made.ID, 0, mint(t), person); err != nil {
		t.Fatal(err)
	}
	if got := said(listOf(t, w.ID, false)); got != "" || active(t, w.ID) != 0 {
		t.Errorf("rotated now, active = %s, %d", got, active(t, w.ID))
	}

	// Its hour up, a rotation is done.
	k2, _ := makeKey(t, w, "Billing")
	_, old2, err := db.RotateKey(ctx, w.ID, k2.ID, time.Hour, mint(t), person)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `UPDATE caller_keys SET expires_at = now() - interval '1 second' WHERE id = $1::uuid`, old2.ID); err != nil {
		t.Fatal(err)
	}
	if got := said(listOf(t, w.ID, false)); got != "" {
		t.Errorf("past its expiry, active = %s", got)
	}
}

// Archive and Restore are recorded, for each kind: a workflow's on its own
// list, with how many keys went; an upstream's and a constant's, which
// nothing live uses, where the API lists them (plan 16, closing plan 15's
// gap).
func TestChanges_ArchiveAndRestore(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	w := create(t)
	makeKey(t, w, "Mobile app")
	if _, err := db.ArchiveWorkflow(ctx, w.ID, other); err != nil {
		t.Fatal(err)
	}
	// Archived already, and restored when it isn't: nothing to record.
	if _, err := db.ArchiveWorkflow(ctx, w.ID, other); err != nil {
		t.Fatal(err)
	}
	if _, err := db.RestoreWorkflow(ctx, w.ID, person); err != nil {
		t.Fatal(err)
	}
	if _, err := db.RestoreWorkflow(ctx, w.ID, person); err != nil {
		t.Fatal(err)
	}
	cs := listOf(t, w.ID, true)
	if said(cs) != "workflow_restored done, workflow_archived done, key_made done" || cs[1].Detail.Keys != 1 ||
		cs[1].Provenance != other || cs[0].Provenance != person {
		t.Errorf("history = %s: %+v", said(cs), cs)
	}

	u, _, err := db.CreateUpstream(ctx, upstreamName(t), upstreamDef(1), person)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SaveUpstreamVersion(ctx, u.ID, 1, upstreamDef(2), person); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := db.ArchiveUpstream(ctx, u.ID, other); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if _, err := db.RestoreUpstream(ctx, u.ID, person); err != nil {
			t.Fatal(err)
		}
	}
	rs, err := db.SubjectChanges(ctx, "upstream", u.ID, 10, "")
	if err != nil {
		t.Fatal(err)
	}
	if got := kinds(rs); got != "upstream_restored upstream_archived upstream_version" || rs[1].Detail.Name != u.Name || rs[1].Provenance != other {
		t.Errorf("the upstream's changes = %s: %+v", got, rs)
	}

	name := constantName(t)
	if _, err := db.CreateConstant(ctx, name, "v", true, person); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ArchiveConstant(ctx, name, other); err != nil {
		t.Fatal(err)
	}
	if _, err := db.RestoreConstant(ctx, name, person); err != nil {
		t.Fatal(err)
	}
	rs, err = db.SubjectChanges(ctx, "constant", name, 10, "")
	if err != nil {
		t.Fatal(err)
	}
	if got := kinds(rs); got != "constant_restored constant_archived" {
		t.Errorf("the constant's changes = %s", got)
	}
}

func kinds(rs []store.ChangeRecord) string {
	out := make([]string, len(rs))
	for i, r := range rs {
		out[i] = r.Kind
	}
	return strings.Join(out, " ")
}

// A list comes a page at a time, newest first.
func TestChanges_Pages(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	w := create(t)
	for i := range 3 {
		makeKey(t, w, fmt.Sprintf("caller %d", i))
	}
	first, err := db.WorkflowChanges(ctx, w.ID, true, 2, "")
	if err != nil || len(first) != 2 || first[0].ID <= first[1].ID || first[0].Detail.Name != "caller 2" {
		t.Fatalf("the first page = %+v, %v", first, err)
	}
	next, err := db.WorkflowChanges(ctx, w.ID, true, 2, first[1].ID)
	if err != nil || len(next) != 1 || next[0].Detail.Name != "caller 0" {
		t.Errorf("the next page = %+v, %v", next, err)
	}
}

// A change and what makes it commit together: a publish whose check fails
// records nothing.
func TestChanges_OnlyWhatCommits(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	billing := saved(t, "Billing", def(1), def(2))
	publish(t, billing.ID, 1)
	caller := saved(t, "Caller", calls(billing.ID, 1))
	wrong := errors.New("it has problems")
	if _, err := db.Publish(ctx, billing.ID, 2, person, func(*workflow.Definition, workflow.Deps) error { return wrong }); !errors.Is(err, wrong) {
		t.Fatal(err)
	}
	if got := said(listOf(t, caller.ID, false)); got != "" {
		t.Errorf("a refused publish was recorded: %s", got)
	}
	publish(t, billing.ID, 2)
	if got := said(listOf(t, caller.ID, false)); got != "workflow_published active" {
		t.Errorf("Caller's changes = %s", got)
	}
}

// A version that changes what an upstream masks says so, as every run masks
// by its newest version's marks at once, whichever version it pins
// (plan 17). The same marks listed in another order change nothing.
func TestChanges_AVersionThatChangesTheMasks(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	version := func(n int, param, masked string) json.RawMessage {
		return json.RawMessage(fmt.Sprintf(`{"n": %d, "parameters": [{"name": "eid"%s}], "request": {"method": "GET", "url": "https://crm.example.com"}, "masked": [%s]}`, n, param, masked))
	}
	u, _, err := db.CreateUpstream(ctx, upstreamName(t), version(1, "", ""), person)
	if err != nil {
		t.Fatal(err)
	}
	using := saved(t, "Using", pins(u.ID, 1))
	for i, tt := range []struct {
		what  string
		def   json.RawMessage
		masks bool
	}{
		{"something else changed", version(2, "", ""), false},
		{"fields marked", version(3, "", `{"field": "a", "mask": {}}, {"field": "b", "mask": {"end": 4}}`), true},
		{"listed in another order", version(4, "", `{"field": "b", "mask": {"end": 4}}, {"field": "a", "mask": {}}`), false},
		{"a parameter marked", version(5, `, "mask": {"end": 4}`, `{"field": "b", "mask": {"end": 4}}, {"field": "a", "mask": {}}`), true},
		{"a mask changed", version(6, `, "mask": {"end": 4}`, `{"field": "b", "mask": {"end": 3}}, {"field": "a", "mask": {}}`), true},
		{"a field unmarked", version(7, `, "mask": {"end": 4}`, `{"field": "a", "mask": {}}`), true},
	} {
		if _, err := db.SaveUpstreamVersion(ctx, u.ID, i+1, tt.def, person); err != nil {
			t.Fatal(err)
		}
		if cs := listOf(t, using.ID, false); len(cs) != i+1 || cs[0].Detail.Version != i+2 || cs[0].Detail.Masks != tt.masks {
			t.Errorf("%s: the newest change = %+v, want masks %v", tt.what, cs[0].Detail, tt.masks)
		}
	}
}
