package httpapi

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/store"
)

// post sends a request with no body.
func post(t *testing.T, path string) reply {
	t.Helper()
	return call(t, http.MethodPost, path, "")
}

// constant makes a constant with a name of its own, and returns the name.
func constant(t *testing.T, value string, secret bool) string {
	t.Helper()
	name := newConstant(t)
	r := call(t, http.MethodPost, "/v1/constants", `{"name": "`+name+`", "value": "`+value+`", "secret": `+strconv.FormatBool(secret)+`}`)
	if r.status != http.StatusCreated {
		t.Fatalf("make a constant = %d %s", r.status, r.body)
	}
	return name
}

// archive archives what's at path, which must go through.
func archive(t *testing.T, path string) {
	t.Helper()
	if r := post(t, path+"/archive"); r.status != http.StatusOK {
		t.Fatalf("archive %s = %d %s", path, r.status, r.body)
	}
}

// Each kind is archived and restored over HTTP, says when and by what, and
// is listed apart while it's archived; and each change is as good as none
// when it's been made (plan 15).
func TestArchive_EachKind(t *testing.T) {
	t.Parallel()
	const missing = "0190d2a5-0000-7000-8000-000000000000"
	// Lists start just after what's made, as other tests are making more.
	workflow := create(t, `{"nodes": []}`).Workflow.ID
	afterWorkflow := create(t, `{"nodes": []}`).Workflow.ID
	upstream := makeUpstream(t, usersAPI).Upstream.ID
	afterUpstream := makeUpstream(t, usersAPI).Upstream.ID
	tests := []struct {
		name, path, list, mark, none string
		marks                        func(t *testing.T, b []byte) (time.Time, gen.Provenance)
	}{
		{
			name: "a workflow", list: "/v1/workflows?before=" + afterWorkflow + "&", none: "/v1/workflows/" + missing,
			path: "/v1/workflows/", mark: workflow,
			marks: func(t *testing.T, b []byte) (time.Time, gen.Provenance) {
				t.Helper()
				w := strict[gen.Workflow](t, b)
				return w.ArchivedAt, w.ArchivedBy
			},
		},
		{
			name: "an upstream", list: "/v1/upstreams?before=" + afterUpstream + "&", none: "/v1/upstreams/" + missing,
			path: "/v1/upstreams/", mark: upstream,
			marks: func(t *testing.T, b []byte) (time.Time, gen.Provenance) {
				t.Helper()
				u := strict[gen.UpstreamSummary](t, b)
				return u.ArchivedAt, u.ArchivedBy
			},
		},
		{
			name: "a constant", list: "/v1/constants?", none: "/v1/constants/c_none",
			path: "/v1/constants/", mark: constant(t, "v", false),
			marks: func(t *testing.T, b []byte) (time.Time, gen.Provenance) {
				t.Helper()
				c := strict[gen.Constant](t, b)
				return c.ArchivedAt, c.ArchivedBy
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			path := tt.path + tt.mark
			listed := func(query string) bool {
				t.Helper()
				r := call(t, http.MethodGet, tt.list+query, "")
				if r.status != http.StatusOK {
					t.Fatalf("list = %d %s", r.status, r.body)
				}
				return strings.Contains(string(r.body), tt.mark)
			}
			if !listed("") || listed("archived=true") {
				t.Errorf("before: in use %t, archived %t", listed(""), listed("archived=true"))
			}
			r := post(t, path+"/archive")
			at, by := tt.marks(t, r.body)
			if r.status != http.StatusOK || at.IsZero() || at.Location() != time.UTC || by.Actor != "token" {
				t.Errorf("archive = %d %s", r.status, r.body)
			}
			if listed("") || listed("archived=false") || !listed("archived=true") {
				t.Errorf("archived: in use %t, archived %t", listed(""), listed("archived=true"))
			}
			again := post(t, path+"/archive")
			if againAt, _ := tt.marks(t, again.body); again.status != http.StatusOK || !againAt.Equal(at) {
				t.Errorf("archive again = %d %s", again.status, again.body)
			}
			r = post(t, path+"/restore")
			if at, by := tt.marks(t, r.body); r.status != http.StatusOK || !at.IsZero() || by.Actor != "" ||
				strings.Contains(string(r.body), "archived") {
				t.Errorf("restore = %d %s", r.status, r.body)
			}
			if !listed("") || listed("archived=true") {
				t.Errorf("restored: in use %t, archived %t", listed(""), listed("archived=true"))
			}
			if r := post(t, path+"/restore"); r.status != http.StatusOK {
				t.Errorf("restore again = %d %s", r.status, r.body)
			}
			for _, verb := range []string{"/archive", "/restore"} {
				if r := post(t, tt.none+verb); r.status != http.StatusNotFound || problemOf(t, r).Code != "not_found" {
					t.Errorf("%s of none = %d %s", verb, r.status, r.body)
				}
			}
		})
	}
}

// Nothing is deleted through the API: the routes that did it have gone.
func TestArchive_NoDeletes(t *testing.T) {
	t.Parallel()
	for _, path := range []string{"/v1/workflows/" + create(t, `{"nodes": []}`).Workflow.ID, "/v1/upstreams/" + makeUpstream(t, usersAPI).Upstream.ID, "/v1/constants/" + constant(t, "v", false)} {
		if r := call(t, http.MethodDelete, path, ""); r.status != http.StatusMethodNotAllowed {
			t.Errorf("DELETE %s = %d %s", path, r.status, r.body)
		}
	}
}

// What something live uses isn't archived, and the refusal names what does.
// Used by lists the same.
func TestArchive_InUse(t *testing.T) {
	t.Parallel()
	refused := func(t *testing.T, path, want string) {
		t.Helper()
		r := post(t, path+"/archive")
		if p := problemOf(t, r); r.status != http.StatusConflict || p.Code != "in_use" || p.Detail != "It's in use, so it can't be archived: "+want+"." {
			t.Errorf("archive %s = %d %+v, want %q", path, r.status, p, want)
		}
	}

	upstream := makeUpstream(t, usersAPI).Upstream.ID
	user := `{"nodes": [{"id": "user", "kind": "http", "uses": {"upstream": "` + upstream + `", "version": 1}, "with": {"user_id": "input.id"}}]}`
	wr := create(t, user)
	refused(t, "/v1/upstreams/"+upstream, "Send to CRM at revision 1")
	users := strict[gen.UpstreamUsers](t, call(t, http.MethodGet, "/v1/upstreams/"+upstream+"/users", "").body)
	if len(users.Workflows) != 1 || users.Workflows[0].WorkflowID != wr.Workflow.ID || users.Workflows[0].Revision != 1 {
		t.Errorf("the upstream's users = %+v", users)
	}

	read := constant(t, "v", false)
	create(t, `{"nodes": [{"id": "crm", "kind": "http", "uses": {"upstream": "u", "version": 1}, "with": {"token": "$const.`+read+`"}}]}`)
	u := makeUpstream(t, `{"request": {"method": "GET", "url": "https://crm.example.com/v1", "headers": {"Authorization": "Bearer {{ $const.`+read+` }}"}}}`)
	refused(t, "/v1/constants/"+read, "Send to CRM at revision 1; the upstream "+u.Upstream.Name+" at version 1")
	readers := strict[gen.ConstantUsers](t, call(t, http.MethodGet, "/v1/constants/"+read+"/users", "").body)
	if len(readers.Workflows) != 1 || readers.Workflows[0].Name != "Send to CRM" || readers.Workflows[0].Revision != 1 ||
		len(readers.Upstreams) != 1 || readers.Upstreams[0].UpstreamID != u.Upstream.ID || readers.Upstreams[0].Version != 1 {
		t.Errorf("the constant's users = %+v", readers)
	}

	inner := create(t, `{"nodes": []}`).Workflow.ID
	create(t, `{"nodes": [{"id": "in", "kind": "http", "uses": {"workflow": "`+inner+`", "revision": 1}}]}`)
	refused(t, "/v1/workflows/"+inner, "Send to CRM at revision 1")
}

func TestUsedBy(t *testing.T) {
	t.Parallel()
	got := usedBy(&store.InUseError{
		Workflows: []store.LiveUse{{Name: "Orders", At: []int{2, 4}}, {Name: "Billing", At: []int{1}}},
		Upstreams: []store.LiveUse{{Name: "CRM", At: []int{1, 2, 5}}},
	})
	if want := "Orders at revisions 2 and 4; Billing at revision 1; the upstream CRM at versions 1, 2 and 5"; got != want {
		t.Errorf("usedBy() = %q, want %q", got, want)
	}
}

// Nothing archived can be changed: each is 409 archived (plan 15).
func TestArchived_RefusesChanges(t *testing.T) {
	t.Parallel()
	wr := create(t, `{"nodes": []}`)
	id := "/v1/workflows/" + wr.Workflow.ID
	key := makeKey(t, wr.Workflow.ID, "acme")
	upstream := "/v1/upstreams/" + makeUpstream(t, usersAPI).Upstream.ID
	name := "/v1/constants/" + constant(t, "first", false)
	if r := call(t, http.MethodPut, name, `{"value": "second"}`); r.status != http.StatusOK {
		t.Fatalf("change the constant = %d %s", r.status, r.body)
	}
	for _, path := range []string{id, upstream, name} {
		archive(t, path)
	}
	for _, tt := range []struct {
		name, method, path, body string
		headers                  []string
	}{
		{"a draft", http.MethodPut, id + "/draft", `{"nodes": [], "sample_input": {}}`, []string{"If-Match", `"1"`}},
		{"a publish", http.MethodPost, id + "/publish", `{"revision": 1}`, nil},
		{"a run", http.MethodPost, id + "/runs", `{"input": {}}`, nil},
		{"a new key", http.MethodPost, id + "/keys", `{"name": "beta"}`, nil},
		{"a rotation", http.MethodPost, id + "/keys/" + key.Key.ID + "/rotate", `{"old_expires_in": "1h"}`, nil},
		{"a version", http.MethodPut, upstream, usersAPI, []string{"If-Match", `"1"`}},
		{"a value", http.MethodPut, name, `{"value": "third"}`, nil},
		{"an undo", http.MethodPost, name + "/undo", "", nil},
	} {
		r := call(t, tt.method, tt.path, tt.body, tt.headers...)
		if p := problemOf(t, r); r.status != http.StatusConflict || p.Code != "archived" || p.Detail != "It's archived, so nothing changes it. Restore it first." {
			t.Errorf("%s = %d %+v", tt.name, r.status, p)
		}
	}
}

// An archived workflow is read as ever: its revision, its keys, its runs.
func TestArchived_StaysReadable(t *testing.T) {
	t.Parallel()
	wr := published(t, "", respondDef)
	makeKey(t, wr.Workflow.ID, "acme")
	id := "/v1/workflows/" + wr.Workflow.ID
	run := startRun(t, wr.Workflow.ID, `{"input": {}}`)
	archive(t, id)
	r := call(t, http.MethodGet, id, "")
	if got := strict[gen.WorkflowRevision](t, r.body); r.status != http.StatusOK || got.Workflow.ArchivedAt.IsZero() || got.Workflow.PublishedRevision != 1 {
		t.Errorf("GET = %d %s", r.status, r.body)
	}
	for _, path := range []string{id + "/revisions", id + "/revisions/1", id + "/keys", "/v1/runs/" + run.ID} {
		if r := call(t, http.MethodGet, path, ""); r.status != http.StatusOK {
			t.Errorf("GET %s = %d %s", path, r.status, r.body)
		}
	}
}

// respondDef answers 200 with nothing but itself.
const respondDef = `{"nodes": [{"id": "hi", "kind": "transform", "expr": "{ 'hello': 'there' }", "unhandled": {"fail": true}}],
  "response": {"answers": [{"status": 200, "lines": [{"from": "hi"}]}]}, "sample_input": {}}`

// An archived workflow's URL stops answering at once, as any refused key is;
// Restore brings no key back, and a new one serves (plan 15).
func TestArchive_StopsServing(t *testing.T) {
	t.Parallel()
	wr := published(t, "", respondDef)
	slug, id := wr.Workflow.Slug, "/v1/workflows/"+wr.Workflow.ID
	key := keyFor(t, wr.Workflow.ID)
	if r := serveWith(t, slug, key, `{}`); r.status != http.StatusOK {
		t.Fatalf("serve = %d %s", r.status, r.body)
	}
	archive(t, id)
	r := serveWith(t, slug, key, `{}`)
	if p := problemOf(t, r); r.status != http.StatusUnauthorized || p.Detail != serveRefused || r.header.Get("WWW-Authenticate") != refusedChallenge {
		t.Errorf("serve archived = %d %+v", r.status, p)
	}
	keys := strict[gen.CallerKeyList](t, call(t, http.MethodGet, id+"/keys", "").body)
	if len(keys.Keys) != 1 || keys.Keys[0].Status != gen.Revoked {
		t.Errorf("its keys = %+v", keys)
	}

	if r := post(t, id+"/restore"); r.status != http.StatusOK {
		t.Fatalf("restore = %d %s", r.status, r.body)
	}
	if r := serveWith(t, slug, key, `{}`); r.status != http.StatusUnauthorized {
		t.Errorf("serve with the old key, restored = %d %s", r.status, r.body)
	}
	if r := serveWith(t, slug, keyFor(t, wr.Workflow.ID), `{}`); r.status != http.StatusOK {
		t.Errorf("serve with a new key = %d %s", r.status, r.body)
	}
}

// Something archived can't be newly used: a draft saves, saying so where it
// does, and can be neither published nor run, directly or through a pin of
// something older. The check says so too (plan 15).
func TestArchived_UsingOneIsAProblem(t *testing.T) {
	t.Parallel()
	retired := makeUpstream(t, usersAPI).Upstream
	archive(t, "/v1/upstreams/"+retired.ID)
	user := `"uses": {"upstream": "` + retired.ID + `", "version": 1}, "with": {"user_id": "'7'"}`
	retiredWorkflow := create(t, `{"nodes": []}`).Workflow.ID
	archive(t, "/v1/workflows/"+retiredWorkflow)
	gone := constant(t, "v", false)
	archive(t, "/v1/constants/"+gone)

	// Revision 1 uses an upstream, and 2 moved off it, so nothing live does,
	// and it can be archived while a later draft pins revision 1.
	pinned := makeUpstream(t, usersAPI).Upstream.ID
	old := create(t, `{"nodes": [{"id": "user", "kind": "http", "uses": {"upstream": "`+pinned+`", "version": 1}, "with": {"user_id": "'7'"}}]}`).Workflow.ID
	if r := call(t, http.MethodPut, "/v1/workflows/"+old+"/draft", `{"nodes": []}`, "If-Match", `"1"`); r.status != http.StatusOK {
		t.Fatalf("draft = %d %s", r.status, r.body)
	}
	archive(t, "/v1/upstreams/"+pinned)

	for _, tt := range []struct{ name, node, want string }{
		{"an upstream", `"kind": "http", ` + user, "/nodes/0/uses archived_upstream"},
		{"a workflow", `"kind": "http", "uses": {"workflow": "` + retiredWorkflow + `", "revision": 1}`, "/nodes/0/uses archived_workflow"},
		{"a constant", `"kind": "transform", "expr": "$const.` + gone + `"`, "/nodes/0/expr archived_constant"},
		{"an upstream through a pin", `"kind": "http", "uses": {"workflow": "` + old + `", "revision": 1}`, "/nodes/0/uses archived_upstream"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			def := `{"nodes": [{"id": "n", "unhandled": {"fail": true}, ` + tt.node + `}],
			  "response": {"answers": [{"status": 200, "lines": [{"from": "n"}]}]}, "sample_input": {}}`
			wr := create(t, def)
			if got := problemPointers(wr.Revision.Problems); got != tt.want {
				t.Errorf("problems = %s, want %s", got, tt.want)
			}
			v := strict[gen.Validation](t, call(t, http.MethodPost, "/v1/validate", def).body)
			if got := problemPointers(v.Problems); got != tt.want {
				t.Errorf("the check says %s, want %s", got, tt.want)
			}
			id := "/v1/workflows/" + wr.Workflow.ID
			r := call(t, http.MethodPost, id+"/publish", `{"revision": 1}`)
			if p := problemOf(t, r); r.status != http.StatusUnprocessableEntity || p.Code != "invalid_definition" || problemPointers(p.Errors) != tt.want {
				t.Errorf("publish = %d %+v", r.status, p)
			}
			r = call(t, http.MethodPost, id+"/runs", `{"input": {}}`)
			if p := problemOf(t, r); r.status != http.StatusUnprocessableEntity || p.Code != "invalid_definition" || problemPointers(p.Errors) != tt.want {
				t.Errorf("run = %d %+v", r.status, p)
			}
		})
	}
}

// A version that reads an archived constant isn't saved, and the check of
// one says why (plan 15).
func TestUpstreams_ArchivedConstant(t *testing.T) {
	t.Parallel()
	gone := constant(t, "v", false)
	archive(t, "/v1/constants/"+gone)
	def := `{"request": {"method": "GET", "url": "https://crm.example.com/v1", "headers": {"X-Code": "{{ $const.` + gone + ` }}"}}}`
	r := call(t, http.MethodPost, "/v1/upstreams", `{"name": "CRM `+newSlug(t)+`", "definition": `+def+`}`)
	if p := problemOf(t, r); r.status != http.StatusUnprocessableEntity || len(p.Errors) != 1 || p.Errors[0].Code != "archived_constant" {
		t.Errorf("POST = %d %+v", r.status, p)
	}
	v := strict[gen.Validation](t, call(t, http.MethodPost, "/v1/upstreams/validate", def).body)
	if len(v.Problems) != 1 || v.Problems[0].Code != "archived_constant" {
		t.Errorf("validate = %+v", v.Problems)
	}
}

// Restore is never refused: what's archived that the thing uses is its
// problem, in what it shows and, for a served workflow, in what it answers.
func TestRestore_NeverRefused(t *testing.T) {
	t.Parallel()
	users := usersUpstream(t)
	defer users.Close()
	wr := published(t, users.URL, answersDef)
	id := "/v1/workflows/" + wr.Workflow.ID
	upstream := wr.Revision.Definition.Nodes[0].Uses.Upstream
	archive(t, id)
	archive(t, "/v1/upstreams/"+upstream)

	if r := post(t, id+"/restore"); r.status != http.StatusOK {
		t.Fatalf("restore = %d %s", r.status, r.body)
	}
	got := strict[gen.WorkflowRevision](t, call(t, http.MethodGet, id, "").body)
	if s := problemPointers(got.Revision.Problems); s != "/nodes/0/uses archived_upstream" {
		t.Errorf("problems = %s", s)
	}
	r := serveWith(t, wr.Workflow.Slug, keyFor(t, wr.Workflow.ID), `{"user_id": "7"}`)
	if p := problemOf(t, r); r.status != http.StatusInternalServerError || problemPointers(p.Errors) != "/nodes/0/uses archived_upstream" {
		t.Errorf("serve = %d %+v", r.status, p)
	}
}

// A name stays taken while what has it is archived, and making one says so
// (plan 15).
func TestArchived_NamesSaySo(t *testing.T) {
	t.Parallel()
	wr := create(t, `{"nodes": []}`)
	u := makeUpstream(t, usersAPI).Upstream
	name := constant(t, "v", false)
	archive(t, "/v1/workflows/"+wr.Workflow.ID)
	archive(t, "/v1/upstreams/"+u.ID)
	archive(t, "/v1/constants/"+name)
	for _, tt := range []struct{ path, body, want string }{
		{"/v1/workflows", `{"slug": "` + wr.Workflow.Slug + `", "name": "Again", "definition": {"nodes": []}}`, "An archived workflow has that slug: restore it, or pick another."},
		{"/v1/upstreams", `{"name": "` + u.Name + `", "definition": ` + usersAPI + `}`, "An archived upstream has that name: restore it, or pick another."},
		{"/v1/constants", `{"name": "` + name + `", "value": "v"}`, "An archived constant has that name: restore it, or pick another."},
	} {
		r := call(t, http.MethodPost, tt.path, tt.body)
		if p := problemOf(t, r); r.status != http.StatusConflict || p.Code != "conflict" || p.Detail != tt.want {
			t.Errorf("POST %s = %d %+v", tt.path, r.status, p)
		}
	}
}
