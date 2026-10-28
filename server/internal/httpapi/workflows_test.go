package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

const validDef = `{"nodes": [{"id": "a", "kind": "transform", "expr": "{ 'ok': true }"}], "output": "nodes.a.body"}`

// invalidDef has two problems: a bad id and an expression that doesn't compile.
const invalidDef = `{"nodes": [{"id": "A", "kind": "transform", "expr": "nodes.a."}]}`

func newSlug(t *testing.T) string {
	t.Helper()
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return "wf-" + hex.EncodeToString(b)
}

func create(t *testing.T, def string) gen.WorkflowRevision {
	t.Helper()
	r := call(t, http.MethodPost, "/v1/workflows", `{"slug": "`+newSlug(t)+`", "name": "Send to CRM", "definition": `+def+`}`)
	if r.status != http.StatusCreated {
		t.Fatalf("create = %d %s", r.status, r.body)
	}
	var wr gen.WorkflowRevision
	if err := json.Unmarshal(r.body, &wr); err != nil {
		t.Fatal(err)
	}
	return wr
}

func pointers(p gen.Problem) string {
	var out []string
	for _, e := range p.Errors {
		out = append(out, e.Pointer+" "+e.Code)
	}
	return strings.Join(out, ", ")
}

func TestCreateWorkflow(t *testing.T) {
	t.Parallel()
	slug := newSlug(t)
	r := call(t, http.MethodPost, "/v1/workflows", `{"slug": "`+slug+`", "name": "Send to CRM", "definition": `+validDef+`}`,
		"User-Agent", "editor/1.0")
	if r.status != http.StatusCreated {
		t.Fatalf("status = %d %s", r.status, r.body)
	}
	var wr gen.WorkflowRevision
	if err := json.Unmarshal(r.body, &wr); err != nil {
		t.Fatal(err)
	}
	if r.header.Get("ETag") != `"1"` || r.header.Get("Location") != "/v1/workflows/"+wr.Workflow.ID {
		t.Errorf("ETag %q, Location %q", r.header.Get("ETag"), r.header.Get("Location"))
	}
	if wr.Workflow.Slug != slug || wr.Revision.Revision != 1 || len(wr.Revision.Problems) != 0 ||
		wr.Revision.Provenance.Actor != "token" || wr.Revision.Provenance.Client != "editor/1.0" {
		t.Errorf("created %+v", wr)
	}
	if !strings.HasSuffix(wr.Workflow.CreatedAt.Format(time.RFC3339Nano), "Z") || !strings.Contains(string(r.body), `Z"`) {
		t.Errorf("times should be UTC: %s", r.body)
	}
	if !strings.Contains(string(r.body), `"problems":[]`) {
		t.Errorf("problems should be [], not absent or null: %s", r.body)
	}
}

func TestCreateWorkflow_SavesAnInvalidDraftWithItsProblems(t *testing.T) {
	t.Parallel()
	wr := create(t, invalidDef)
	got := []string{}
	for _, p := range wr.Revision.Problems {
		got = append(got, p.Pointer+" "+p.Code)
	}
	if want := "/nodes/0/id invalid_id, /nodes/0/expr invalid_expression"; strings.Join(got, ", ") != want {
		t.Errorf("problems = %q, want %q", strings.Join(got, ", "), want)
	}
}

func TestCreateWorkflow_Refusals(t *testing.T) {
	t.Parallel()
	taken := create(t, validDef).Workflow.Slug
	tests := []struct {
		name, body string
		status     int
		code       string
		pointers   string
	}{
		{
			"bad slug and name", `{"slug": "Has Spaces", "name": "", "definition": ` + validDef + `}`,
			422, "invalid_request", "/slug invalid_slug, /name invalid_name",
		},
		{"taken slug", `{"slug": "` + taken + `", "name": "x", "definition": ` + validDef + `}`, 409, "conflict", ""},
		{
			"unknown fields, at any depth", `{"slug": "x", "name": "x", "extra": 1, "definition": {"nodes": [{"id": "a", "kind": "http",
			"request": {"method": "GET", "url": "https://x.example/", "timout_ms": 2000}}]}}`,
			422, "invalid_request", "/definition/nodes/0/request/timout_ms unknown_field, /extra unknown_field",
		},
		{
			"wrong types", `{"slug": 7, "name": "x", "definition": {"nodes": [{"id": "a", "kind": "http",
			"request": {"method": "GET", "url": "https://x.example/", "timeout_ms": "2000", "headers": {"A": 1}}}]}}`,
			422, "invalid_request", "/definition/nodes/0/request/headers/A invalid_type, /definition/nodes/0/request/timeout_ms invalid_type, /slug invalid_type",
		},
		{
			"a fraction where a whole number goes", `{"slug": "x", "name": "x", "definition": {"nodes": [{"id": "a", "kind": "http",
			"request": {"method": "GET", "url": "https://x.example/", "timeout_ms": 1.5}}]}}`,
			422, "invalid_request", "/definition/nodes/0/request/timeout_ms invalid_type",
		},
		{
			"a position that isn't one", `{"slug": "x", "name": "x", "definition": {"nodes": [{"id": "a", "kind": "transform", "expr": "1"}],
			"ui": {"positions": {"a": {"x": "120", "y": 0, "z": 1}}}}}`,
			422, "invalid_request", "/definition/ui/positions/a/x invalid_type, /definition/ui/positions/a/z unknown_field",
		},
		{"not JSON", `{"slug": `, 400, "invalid_json", ""},
		{"too large", `{"slug": "` + strings.Repeat("x", maxBody) + `"}`, 413, "too_large", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			r := call(t, http.MethodPost, "/v1/workflows", tt.body)
			if r.status != tt.status {
				t.Fatalf("status = %d, want %d; body %.300s", r.status, tt.status, r.body)
			}
			p := problemOf(t, r)
			if p.Code != tt.code || pointers(p) != tt.pointers {
				t.Errorf("code %q, pointers %q; want %q, %q", p.Code, pointers(p), tt.code, tt.pointers)
			}
		})
	}
}

// Every route with a JSON body refuses an unknown field, so none falls back
// to encoding/json silently dropping it.
func TestEveryJSONBodyRefusesUnknownFields(t *testing.T) {
	t.Parallel()
	id := create(t, validDef).Workflow.ID
	paths := map[string]string{
		"POST /v1/workflows":              "/v1/workflows",
		"PUT /v1/workflows/{id}/draft":    "/v1/workflows/" + id + "/draft",
		"POST /v1/workflows/{id}/publish": "/v1/workflows/" + id + "/publish",
		"POST /v1/validate":               "/v1/validate",
		"POST /v1/workflows/{id}/runs":    "/v1/workflows/" + id + "/runs",
		"POST /v1/session":                "/v1/session",
	}
	for pattern := range bodies {
		path, ok := paths[pattern]
		if !ok {
			t.Errorf("no test path for %s", pattern)
			continue
		}
		method, _, _ := strings.Cut(pattern, " ")
		r := call(t, method, path, `{"surprise": true}`, "If-Match", `"1"`)
		if p := problemOf(t, r); r.status != 422 || !strings.Contains(pointers(p), "/surprise unknown_field") {
			t.Errorf("%s: %d %s", pattern, r.status, r.body)
		}
	}
}

func TestGetWorkflow(t *testing.T) {
	t.Parallel()
	wr := create(t, validDef)
	r := call(t, http.MethodGet, "/v1/workflows/"+wr.Workflow.ID, "")
	if r.status != http.StatusOK || r.header.Get("ETag") != `"1"` {
		t.Fatalf("GET = %d, ETag %q; %s", r.status, r.header.Get("ETag"), r.body)
	}
	for _, id := range []string{"0190d2a5-0000-7000-8000-000000000000", "not-a-uuid"} {
		r := call(t, http.MethodGet, "/v1/workflows/"+id, "")
		if p := problemOf(t, r); r.status != http.StatusNotFound || p.Code != "not_found" {
			t.Errorf("GET %s = %d %+v", id, r.status, p)
		}
	}
}

// The editor's positions are stored with the revision and come back as they
// were sent. A definition without them comes back without a ui block.
func TestGetWorkflow_KeepsPositions(t *testing.T) {
	t.Parallel()
	placed := create(t, `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}], "ui": {"positions": {"a": {"x": 120.5, "y": -40}}}}`)
	r := call(t, http.MethodGet, "/v1/workflows/"+placed.Workflow.ID, "")
	var got gen.WorkflowRevision
	if err := json.Unmarshal(r.body, &got); err != nil {
		t.Fatal(err)
	}
	if ui := got.Revision.Definition.UI; ui == nil || ui.Positions["a"] != (workflow.Position{X: 120.5, Y: -40}) {
		t.Errorf("positions = %+v; body %s", ui, r.body)
	}

	r = call(t, http.MethodGet, "/v1/workflows/"+create(t, validDef).Workflow.ID, "")
	if strings.Contains(string(r.body), `"ui"`) {
		t.Errorf("a definition without positions gained a ui block: %s", r.body)
	}
}

func TestSaveDraft(t *testing.T) {
	t.Parallel()
	id := create(t, validDef).Workflow.ID
	path := "/v1/workflows/" + id + "/draft"

	r := call(t, http.MethodPut, path, invalidDef)
	if p := problemOf(t, r); r.status != http.StatusPreconditionRequired || p.Code != "if_match_required" {
		t.Errorf("without If-Match: %d %+v", r.status, p)
	}
	for _, bad := range []string{`"2"`, `W/"1"`, `*`, `1`} {
		r := call(t, http.MethodPut, path, invalidDef, "If-Match", bad)
		if p := problemOf(t, r); r.status != http.StatusPreconditionFailed || p.Code != "revision_mismatch" {
			t.Errorf("If-Match %s: %d %+v", bad, r.status, p)
		}
	}
	r = call(t, http.MethodPut, path, invalidDef, "If-Match", `"1"`)
	if r.status != http.StatusOK || r.header.Get("ETag") != `"2"` {
		t.Fatalf("save on 1 = %d, ETag %q; %s", r.status, r.header.Get("ETag"), r.body)
	}
	var rev gen.Revision
	if err := json.Unmarshal(r.body, &rev); err != nil || rev.Revision != 2 || len(rev.Problems) != 2 {
		t.Errorf("saved %+v, %v; want revision 2 with its 2 problems", rev, err)
	}
	r = call(t, http.MethodPut, "/v1/workflows/0190d2a5-0000-7000-8000-000000000000/draft", validDef, "If-Match", `"1"`)
	if r.status != http.StatusNotFound {
		t.Errorf("save to a missing workflow = %d %s", r.status, r.body)
	}
}

func TestRevisions(t *testing.T) {
	t.Parallel()
	id := create(t, validDef).Workflow.ID
	if r := call(t, http.MethodPut, "/v1/workflows/"+id+"/draft", invalidDef, "If-Match", `"1"`); r.status != 200 {
		t.Fatalf("save = %d %s", r.status, r.body)
	}
	r := call(t, http.MethodGet, "/v1/workflows/"+id+"/revisions", "")
	var list gen.RevisionList
	if err := json.Unmarshal(r.body, &list); err != nil || r.status != 200 || len(list.Revisions) != 2 || list.Revisions[0].Revision != 2 {
		t.Errorf("revisions = %d %s", r.status, r.body)
	}
	r = call(t, http.MethodGet, "/v1/workflows/"+id+"/revisions/1", "")
	var rev gen.Revision
	if err := json.Unmarshal(r.body, &rev); err != nil || r.status != 200 || rev.Revision != 1 || len(rev.Definition.Nodes) != 1 {
		t.Errorf("revision 1 = %d %s", r.status, r.body)
	}
	for _, path := range []string{"/v1/workflows/" + id + "/revisions/9", "/v1/workflows/0190d2a5-0000-7000-8000-000000000000/revisions"} {
		if r := call(t, http.MethodGet, path, ""); r.status != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", path, r.status)
		}
	}
	if r := call(t, http.MethodGet, "/v1/workflows/"+id+"/revisions/one", ""); r.status != http.StatusBadRequest {
		t.Errorf("a revision that isn't a number = %d %s, want 400", r.status, r.body)
	}
}

func TestPublish(t *testing.T) {
	t.Parallel()
	id := create(t, validDef).Workflow.ID
	if r := call(t, http.MethodPut, "/v1/workflows/"+id+"/draft", invalidDef, "If-Match", `"1"`); r.status != 200 {
		t.Fatalf("save = %d %s", r.status, r.body)
	}
	r := call(t, http.MethodPost, "/v1/workflows/"+id+"/publish", `{"revision": 2}`)
	if p := problemOf(t, r); r.status != 422 || p.Code != "invalid_definition" || len(p.Errors) != 2 {
		t.Errorf("publish an invalid revision = %d %+v", r.status, p)
	}
	r = call(t, http.MethodPost, "/v1/workflows/"+id+"/publish", `{"revision": 1}`)
	var w gen.Workflow
	if err := json.Unmarshal(r.body, &w); err != nil || r.status != 200 || w.PublishedRevision != 1 {
		t.Errorf("publish revision 1 = %d %s", r.status, r.body)
	}
	if r := call(t, http.MethodPost, "/v1/workflows/"+id+"/publish", `{"revision": 7}`); r.status != http.StatusNotFound {
		t.Errorf("publish a revision that doesn't exist = %d, want 404", r.status)
	}
}

func TestValidate(t *testing.T) {
	t.Parallel()
	if r := call(t, http.MethodPost, "/v1/validate", validDef); r.status != http.StatusNoContent {
		t.Errorf("valid = %d %s", r.status, r.body)
	}
	r := call(t, http.MethodPost, "/v1/validate", invalidDef)
	if p := problemOf(t, r); r.status != 422 || pointers(p) != "/nodes/0/id invalid_id, /nodes/0/expr invalid_expression" {
		t.Errorf("invalid = %d %+v", r.status, p)
	}
}

func TestListWorkflows(t *testing.T) {
	t.Parallel()
	for range 3 {
		create(t, validDef)
	}
	r := call(t, http.MethodGet, "/v1/workflows?limit=2", "")
	var page gen.WorkflowList
	if err := json.Unmarshal(r.body, &page); err != nil || r.status != 200 || len(page.Workflows) != 2 || page.Next == "" {
		t.Fatalf("first page = %d %s", r.status, r.body)
	}
	r = call(t, http.MethodGet, "/v1/workflows?limit=2&before="+page.Next, "")
	var next gen.WorkflowList
	if err := json.Unmarshal(r.body, &next); err != nil || r.status != 200 || len(next.Workflows) == 0 || next.Workflows[0].ID >= page.Next {
		t.Errorf("next page = %d %s", r.status, r.body)
	}
	for _, q := range []string{"limit=0x", "limit=500", "limit=-1"} {
		if r := call(t, http.MethodGet, "/v1/workflows?"+q, ""); r.status != http.StatusBadRequest {
			t.Errorf("?%s = %d %s, want 400", q, r.status, r.body)
		}
	}
}
