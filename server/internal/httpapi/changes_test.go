package httpapi

import (
	"net/http"
	"strings"
	"testing"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
)

// changes is workflow id's list over HTTP, its active changes or its
// history.
func changes(t *testing.T, id string, history bool) []gen.Change {
	t.Helper()
	path := "/v1/workflows/" + id + "/changes"
	if history {
		path += "?history=true"
	}
	r := call(t, http.MethodGet, path, "")
	if r.status != http.StatusOK {
		t.Fatalf("GET %s = %d %s", path, r.status, r.body)
	}
	return strict[gen.ChangeList](t, r.body).Changes
}

// A constant changed over HTTP is on the list of the workflow that reads
// it: active, counted on the workflow, and dismissed into its history; and
// no response holds a secret's value (plan 16).
func TestChanges_OverHTTP(t *testing.T) {
	t.Parallel()
	const value = "sk_live_changes_http_0123456789"
	name := constant(t, "first", true)
	wr := create(t, `{"nodes": [{"id": "pick", "kind": "transform", "expr": "$const.`+name+`"}]}`)
	id := "/v1/workflows/" + wr.Workflow.ID
	if r := call(t, http.MethodPut, "/v1/constants/"+name, `{"value": "`+value+`"}`); r.status != http.StatusOK {
		t.Fatalf("PUT = %d %s", r.status, r.body)
	}
	cs := changes(t, wr.Workflow.ID, false)
	if len(cs) != 1 || cs[0].Kind != gen.ChangeKindConstantChanged || cs[0].State != gen.ChangeStateActive ||
		cs[0].Subject != gen.ChangeSubjectConstant || cs[0].SubjectID != name || cs[0].Detail.Name != name ||
		cs[0].Detail.How != gen.Set || cs[0].Provenance.Actor != "token" {
		t.Fatalf("changes = %+v", cs)
	}
	w := strict[gen.WorkflowRevision](t, call(t, http.MethodGet, id, "").body).Workflow
	if w.ActiveChanges != 1 {
		t.Errorf("active_changes = %d, want 1", w.ActiveChanges)
	}

	r := call(t, http.MethodPost, id+"/changes/"+cs[0].ID+"/dismiss", "")
	gone := strict[gen.Change](t, r.body)
	if r.status != http.StatusOK || gone.State != gen.ChangeStateDismissed || gone.DismissedAt.IsZero() || gone.DismissedBy.Actor != "token" {
		t.Errorf("dismiss = %d %s", r.status, r.body)
	}
	if got := changes(t, wr.Workflow.ID, false); len(got) != 0 {
		t.Errorf("active after the dismissal = %+v", got)
	}
	history := changes(t, wr.Workflow.ID, true)
	if len(history) != 1 || history[0].State != gen.ChangeStateDismissed {
		t.Errorf("history = %+v", history)
	}

	for _, path := range []string{id + "/changes", id + "/changes?history=true", "/v1/constants/" + name + "/changes"} {
		if r := call(t, http.MethodGet, path, ""); strings.Contains(string(r.body), value) {
			t.Errorf("%s holds the secret: %s", path, r.body)
		}
	}
	for _, tt := range []struct{ method, path string }{
		{http.MethodPost, id + "/changes/0190d2a5-0000-7000-8000-000000000000/dismiss"},
		{http.MethodPost, id + "/changes/not-an-id/dismiss"},
		{http.MethodGet, "/v1/workflows/0190d2a5-0000-7000-8000-000000000000/changes"},
		{http.MethodGet, "/v1/upstreams/0190d2a5-0000-7000-8000-000000000000/changes"},
		{http.MethodGet, "/v1/constants/c_none/changes"},
	} {
		if r := call(t, tt.method, tt.path, ""); r.status != http.StatusNotFound || problemOf(t, r).Code != "not_found" {
			t.Errorf("%s %s = %d %s", tt.method, tt.path, r.status, r.body)
		}
	}
}

// A newer version of an upstream, and a key rotated with an hour to change
// over, are active on the list of the workflow they touch (plan 16); the
// version says it marks what the last didn't (plan 17).
func TestChanges_AVersionAndAKey(t *testing.T) {
	t.Parallel()
	u := makeUpstream(t, usersAPI)
	wr := create(t, `{"nodes": [{"id": "user", "kind": "http", "uses": {"upstream": "`+u.Upstream.ID+`", "version": 1}, "with": {"user_id": "'7'"}}]}`)
	saved := strings.Replace(usersAPI, `{"name": "user_id"}`, `{"name": "user_id", "mask": {"end": 2}}`, 1)
	if r := call(t, http.MethodPut, "/v1/upstreams/"+u.Upstream.ID, saved, "If-Match", `"1"`); r.status != http.StatusOK {
		t.Fatalf("save = %d %s", r.status, r.body)
	}
	key := makeKey(t, wr.Workflow.ID, "Mobile app")
	if r := rotate(t, wr.Workflow.ID, key.Key.ID, "1h"); r.status != http.StatusOK {
		t.Fatalf("rotate = %d %s", r.status, r.body)
	}
	cs := changes(t, wr.Workflow.ID, false)
	if len(cs) != 2 || cs[0].Kind != gen.ChangeKindKeyRotated || cs[0].Detail.ExpiresAt.IsZero() || cs[0].Detail.Prefix != key.Key.Prefix ||
		cs[1].Kind != gen.ChangeKindUpstreamVersion || cs[1].Detail.Version != 2 || !cs[1].Detail.Masks || cs[1].SubjectID != u.Upstream.ID {
		t.Errorf("changes = %+v", cs)
	}

	r := call(t, http.MethodGet, "/v1/upstreams/"+u.Upstream.ID+"/changes", "")
	rs := strict[gen.ChangeRecordList](t, r.body).Changes
	if r.status != http.StatusOK || len(rs) != 1 || rs[0].Kind != gen.ChangeRecordKindUpstreamVersion || rs[0].Detail.Version != 2 {
		t.Errorf("the upstream's changes = %d %s", r.status, r.body)
	}
}
