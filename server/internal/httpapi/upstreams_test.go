package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
)

// usersAPI is a whole upstream: one parameter, read by its URL.
const usersAPI = `{"parameters": [{"name": "user_id"}], "request": {"method": "GET", "url": "https://users.example.com/v1/users/{{ user_id }}"}}`

// makeUpstream makes an upstream from def, under a name of its own.
func makeUpstream(t *testing.T, def string) gen.UpstreamVersion {
	t.Helper()
	r := call(t, http.MethodPost, "/v1/upstreams", `{"name": "Users `+newSlug(t)+`", "definition": `+def+`}`)
	if r.status != http.StatusCreated {
		t.Fatalf("make upstream = %d %s", r.status, r.body)
	}
	return strict[gen.UpstreamVersion](t, r.body)
}

// placeholder is a template's {{ expression }}.
var placeholder = regexp.MustCompile(`\{\{([\s\S]*?)\}\}`)

// withUpstreams saves each HTTP step's own request in def as an upstream,
// through the API, and has the step use it, each placeholder and the body a
// parameter given what it read, as the editor's Save as upstream does:
// Publish takes only steps that use one (plan 07).
func withUpstreams(t *testing.T, def string) string {
	t.Helper()
	var d map[string]any
	if err := json.Unmarshal([]byte(def), &d); err != nil {
		t.Fatalf("decode definition: %v", err)
	}
	nodes, _ := d["nodes"].([]any)
	for _, raw := range nodes {
		n, _ := raw.(map[string]any)
		req, own := n["request"].(map[string]any)
		if n["kind"] != "http" || !own {
			continue
		}
		params := []map[string]string{}
		with := map[string]string{}
		param := func(expr string) string {
			name := fmt.Sprintf("p%d", len(params)+1)
			params = append(params, map[string]string{"name": name})
			with[name] = expr
			return name
		}
		template := func(s string) string {
			return placeholder.ReplaceAllStringFunc(s, func(m string) string {
				return "{{ " + param(strings.TrimSpace(m[2:len(m)-2])) + " }}"
			})
		}
		req["url"] = template(req["url"].(string))
		for _, part := range []string{"headers", "query"} {
			if m, ok := req[part].(map[string]any); ok {
				for k, v := range m {
					m[k] = template(v.(string))
				}
			}
		}
		if body, ok := req["body"].(string); ok {
			req["body"] = param(body)
		}
		u := map[string]any{"parameters": params, "request": req}
		for _, k := range []string{"outputs", "sample"} {
			if v, ok := n[k]; ok {
				u[k] = v
				delete(n, k)
			}
		}
		b, err := json.Marshal(u)
		if err != nil {
			t.Fatal(err)
		}
		made := makeUpstream(t, string(b))
		n["uses"] = map[string]any{"upstream": made.Upstream.ID, "version": made.Version}
		n["with"] = with
		delete(n, "request")
	}
	b, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The library over HTTP (plan 07): an upstream is made at version 1, each
// save on its latest version makes the next, and every version reads as it
// was saved.
func TestUpstreams(t *testing.T) {
	t.Parallel()
	name := "Users " + newSlug(t)
	r := call(t, http.MethodPost, "/v1/upstreams", `{"name": "`+name+`", "definition": `+usersAPI+`}`)
	if r.status != http.StatusCreated || r.header.Get("ETag") != `"1"` {
		t.Fatalf("make = %d, ETag %q; %s", r.status, r.header.Get("ETag"), r.body)
	}
	made := strict[gen.UpstreamVersion](t, r.body)
	id := made.Upstream.ID
	if made.Upstream.Name != name || made.Version != 1 || made.Upstream.LatestVersion != 1 || made.Provenance.Actor != "token" ||
		r.header.Get("Location") != "/v1/upstreams/"+id || len(made.Definition.Parameters) != 1 {
		t.Errorf("made %+v, Location %q", made, r.header.Get("Location"))
	}

	saved := strings.Replace(usersAPI, `"method": "GET"`, `"method": "GET", "query": {"fields": "all"}`, 1)
	if r = call(t, http.MethodPut, "/v1/upstreams/"+id, saved, "If-Match", `"1"`); r.status != http.StatusOK || r.header.Get("ETag") != `"2"` {
		t.Fatalf("save on 1 = %d, ETag %q; %s", r.status, r.header.Get("ETag"), r.body)
	}
	if v := strict[gen.UpstreamVersion](t, r.body); v.Version != 2 || v.Upstream.LatestVersion != 2 || v.Definition.Request.Query["fields"] != "all" {
		t.Errorf("saved %+v", v)
	}
	// A save that changes nothing makes no version: 2 is the answer.
	if r = call(t, http.MethodPut, "/v1/upstreams/"+id, saved, "If-Match", `"2"`); r.status != http.StatusOK || r.header.Get("ETag") != `"2"` ||
		strict[gen.UpstreamVersion](t, r.body).Upstream.LatestVersion != 2 {
		t.Errorf("a save on 2 that changes nothing = %d, ETag %q; %s", r.status, r.header.Get("ETag"), r.body)
	}
	if r = call(t, http.MethodGet, "/v1/upstreams/"+id, ""); r.status != http.StatusOK || r.header.Get("ETag") != `"2"` ||
		strict[gen.UpstreamVersion](t, r.body).Version != 2 {
		t.Errorf("GET = %d, ETag %q; %s", r.status, r.header.Get("ETag"), r.body)
	}
	// Version 1 is as it was.
	if r = call(t, http.MethodGet, "/v1/upstreams/"+id+"/versions/1", ""); r.status != http.StatusOK ||
		strict[gen.UpstreamVersion](t, r.body).Definition.Request.Query != nil {
		t.Errorf("GET version 1 = %d %s", r.status, r.body)
	}
	// A page names the next, while there may be more.
	if r = call(t, http.MethodGet, "/v1/upstreams?limit=1", ""); strict[gen.UpstreamList](t, r.body).Next == "" {
		t.Errorf("a page of 1 names no next: %s", r.body)
	}
	r = call(t, http.MethodGet, "/v1/upstreams?limit=200", "")
	list := strict[gen.UpstreamList](t, r.body).Upstreams
	if !slices.ContainsFunc(list, func(u gen.UpstreamSummary) bool { return u.ID == id && u.LatestVersion == 2 }) {
		t.Errorf("the list has no %s at version 2: %s", id, r.body)
	}
}

// A version never changes once saved, and steps pin one, so a definition
// with problems isn't saved at all.
func TestUpstreams_Refusals(t *testing.T) {
	t.Parallel()
	id := makeUpstream(t, usersAPI).Upstream.ID
	typo := strings.Replace(usersAPI, "{{ user_id }}", "{{ usr_id }}", 1)
	tests := []struct {
		name, method, path, body string
		headers                  []string
		status                   int
		code, errs               string
	}{
		{
			"a problem in a new one", http.MethodPost, "/v1/upstreams", `{"name": "Users ` + newSlug(t) + `", "definition": ` + typo + `}`, nil,
			http.StatusUnprocessableEntity, "invalid_upstream", "/definition/request/url unknown_parameter",
		},
		{
			"a problem in a new version", http.MethodPut, "/v1/upstreams/" + id, typo,
			[]string{"If-Match", `"1"`},
			http.StatusUnprocessableEntity, "invalid_upstream", "/request/url unknown_parameter",
		},
		{
			"no name", http.MethodPost, "/v1/upstreams", `{"name": "", "definition": ` + usersAPI + `}`, nil,
			http.StatusUnprocessableEntity, "invalid_request", "/name invalid_name",
		},
		{
			"a save on a version that isn't the latest", http.MethodPut, "/v1/upstreams/" + id, usersAPI,
			[]string{"If-Match", `"7"`},
			http.StatusPreconditionFailed, "version_mismatch", "",
		},
		{
			"a save naming none", http.MethodPut, "/v1/upstreams/" + id, usersAPI, nil,
			http.StatusPreconditionRequired, "if_match_required", "",
		},
		{
			"no such upstream", http.MethodGet, "/v1/upstreams/0190d2a5-0000-7000-8000-000000000000", "", nil,
			http.StatusNotFound, "not_found", "",
		},
		{
			"no such version", http.MethodGet, "/v1/upstreams/" + id + "/versions/9", "", nil,
			http.StatusNotFound, "not_found", "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			r := call(t, tt.method, tt.path, tt.body, tt.headers...)
			if p := problemOf(t, r); r.status != tt.status || p.Code != tt.code || !strings.Contains(pointers(p), tt.errs) ||
				(r.status == http.StatusNotFound && !strings.Contains(p.Detail, "upstream")) {
				t.Errorf("%s %s = %d %+v", tt.method, tt.path, r.status, p)
			}
		})
	}
}

// An If-Match that names no version says so, rather than that another was
// saved first.
func TestUpstreams_AnIfMatchThatNamesNoVersion(t *testing.T) {
	t.Parallel()
	id := makeUpstream(t, usersAPI).Upstream.ID
	r := call(t, http.MethodPut, "/v1/upstreams/"+id, usersAPI, "If-Match", `W/"x"`)
	if p := problemOf(t, r); r.status != http.StatusPreconditionFailed || !strings.Contains(p.Detail, "one version's ETag") {
		t.Errorf("PUT with If-Match W/\"x\" = %d %+v", r.status, p)
	}
}

// An upstream can be checked without saving it, as its page does while
// it's edited.
func TestUpstreams_Validate(t *testing.T) {
	t.Parallel()
	typo := strings.Replace(usersAPI, "{{ user_id }}", "{{ usr_id }}", 1)
	r := call(t, http.MethodPost, "/v1/upstreams/validate", typo)
	if v := strict[gen.Validation](t, r.body); r.status != http.StatusOK || problemPointers(v.Problems) != "/request/url unknown_parameter" {
		t.Errorf("validate = %d %s", r.status, r.body)
	}
	if r = call(t, http.MethodPost, "/v1/upstreams/validate", usersAPI); len(strict[gen.Validation](t, r.body).Problems) != 0 {
		t.Errorf("validate a whole one = %s", r.body)
	}
}

// A name is the library's, so it's taken once.
func TestUpstreams_ANameIsTakenOnce(t *testing.T) {
	t.Parallel()
	name := "Users " + newSlug(t)
	body := `{"name": "` + name + `", "definition": ` + usersAPI + `}`
	if r := call(t, http.MethodPost, "/v1/upstreams", body); r.status != http.StatusCreated {
		t.Fatalf("make = %d %s", r.status, r.body)
	}
	r := call(t, http.MethodPost, "/v1/upstreams", body)
	if p := problemOf(t, r); r.status != http.StatusConflict || p.Code != "conflict" || !strings.Contains(p.Detail, "name") {
		t.Errorf("make it again = %d %+v", r.status, p)
	}
}

// A workflow whose step uses an upstream (plan 07): saved, its problems are
// how it uses the upstream; previewed, the request renders the parameters'
// values over the version; published, it serves through the version, and
// answers 404 through the version's 404.
func TestUpstreams_AStepThatUsesOne(t *testing.T) {
	t.Parallel()
	base := usersUpstream(t).URL
	users := makeUpstream(t, `{"parameters": [{"name": "user_id"}], "request": {"method": "GET", "url": "`+base+`/users/{{ user_id }}"},
	  "sample": {"body": {"id": "7", "name": "Ada"}}, "outputs": [{"status": 404}]}`)
	def := func(with string) string {
		return `{"nodes": [{"id": "user", "kind": "http", "unhandled": {"fail": true},
		    "uses": {"upstream": "` + users.Upstream.ID + `", "version": 1}, "with": ` + with + `}],
		  "response": {"answers": [{"status": 200, "lines": [{"from": "user"}]}, {"status": 404, "lines": [{"from": "user", "on": 404}]}]},
		  "sample_input": {"user_id": "7"}}`
	}

	// A parameter with no value is a problem of the step's.
	unbound := create(t, def(`{}`))
	if got := problemPointers(unbound.Revision.Problems); got != "/nodes/0/with/user_id required" {
		t.Errorf("problems with no value = %s", got)
	}

	wr := create(t, def(`{"user_id": "input.user_id"}`))
	if len(wr.Revision.Problems) > 0 {
		t.Fatalf("problems = %+v", wr.Revision.Problems)
	}
	r := call(t, http.MethodPost, "/v1/preview", `{"definition": `+def(`{"user_id": "input.user_id"}`)+`, "node": "user"}`)
	if pv := strict[gen.Preview](t, r.body); r.status != http.StatusOK || pv.Sends.URL != base+"/users/7" ||
		string(pv.Parameters) != `{"user_id":"7"}` {
		t.Errorf("preview = %d %s", r.status, r.body)
	}

	if r = call(t, http.MethodPost, "/v1/workflows/"+wr.Workflow.ID+"/publish", `{"revision": 1}`); r.status != http.StatusOK {
		t.Fatalf("publish = %d %s", r.status, r.body)
	}
	key := keyFor(t, wr.Workflow.ID)
	if r = serveWith(t, wr.Workflow.Slug, key, `{"user_id": "7"}`); r.status != http.StatusOK || !strings.Contains(string(r.body), `"Ada"`) {
		t.Errorf("serve 7 = %d %s", r.status, r.body)
	}
	if r = serveWith(t, wr.Workflow.Slug, key, `{"user_id": "gone"}`); r.status != http.StatusNotFound {
		t.Errorf("serve gone = %d %s", r.status, r.body)
	}
	// The library says which workflow that uses it is served.
	r = call(t, http.MethodGet, "/v1/upstreams/"+users.Upstream.ID+"/users", "")
	u := strict[gen.UpstreamUsers](t, r.body)
	served := slices.IndexFunc(u.Workflows, func(w gen.UpstreamUse) bool { return w.Published })
	if r.status != http.StatusOK || served < 0 || u.Workflows[served].WorkflowID != wr.Workflow.ID {
		t.Errorf("users = %d %s", r.status, r.body)
	}
}

// The library says which workflows use an upstream, and which versions; and
// a preview can use an unsaved version, to show what an edit would do.
func TestUpstreams_UsersAndUnsavedVersions(t *testing.T) {
	t.Parallel()
	users := makeUpstream(t, usersAPI)
	id := users.Upstream.ID
	def := `{"nodes": [{"id": "user", "kind": "http", "unhandled": {"fail": true},
	    "uses": {"upstream": "` + id + `", "version": 1}, "with": {"user_id": "input.user_id"}}],
	  "sample_input": {"user_id": "7"}}`
	wr := create(t, def)

	r := call(t, http.MethodGet, "/v1/upstreams/"+id+"/users", "")
	if u := strict[gen.UpstreamUsers](t, r.body); r.status != http.StatusOK || len(u.Workflows) != 1 ||
		u.Workflows[0].WorkflowID != wr.Workflow.ID || !slices.Equal(u.Workflows[0].Versions, []int{1}) || u.Workflows[0].Published {
		t.Errorf("users = %d %s", r.status, r.body)
	}
	if r = call(t, http.MethodGet, "/v1/upstreams/0190d2a5-0000-7000-8000-000000000000/users", ""); r.status != http.StatusNotFound {
		t.Errorf("users of none = %d %s", r.status, r.body)
	}

	edited := strings.Replace(usersAPI, "/v1/users/", "/v2/people/", 1)
	r = call(t, http.MethodPost, "/v1/preview", `{"definition": `+def+`, "node": "user", "upstreams": {"user": `+edited+`}}`)
	if pv := strict[gen.Preview](t, r.body); r.status != http.StatusOK || pv.Sends.URL != "https://users.example.com/v2/people/7" {
		t.Errorf("preview with an unsaved version = %d %s", r.status, r.body)
	}

	// The edit is the step's it's given for: another step pinned to the same
	// version previews the saved one, and a step with a request of its own
	// keeps it.
	two := `{"nodes": [
	    {"id": "user", "kind": "http", "uses": {"upstream": "` + id + `", "version": 1}, "with": {"user_id": "input.user_id"}},
	    {"id": "again", "kind": "http", "uses": {"upstream": "` + id + `", "version": 1}, "with": {"user_id": "input.user_id"}},
	    {"id": "own", "kind": "http", "request": {"method": "GET", "url": "https://own.example.com/{{ input.user_id }}"}}],
	  "sample_input": {"user_id": "7"}}`
	for node, want := range map[string]string{"again": "https://users.example.com/v1/users/7", "own": "https://own.example.com/7"} {
		r = call(t, http.MethodPost, "/v1/preview", `{"definition": `+two+`, "node": "`+node+`", "upstreams": {"user": `+edited+`, "own": `+edited+`}}`)
		if pv := strict[gen.Preview](t, r.body); r.status != http.StatusOK || pv.Sends.URL != want {
			t.Errorf("preview of %s beside an unsaved version = %d %s", node, r.status, r.body)
		}
	}
}

// A published workflow is an upstream too (plan 07): a step uses one of
// its revisions, giving its input's fields values. Saved, the step's
// problems are how it uses it; previewed, it gets what the workflow's own
// preview answers over what the step gives; served, the workflow runs as a
// run of its own, called from the step, and its answer is the step's
// response. A workflow can't use itself, directly or through another.
func TestWorkflowsAsSteps(t *testing.T) {
	t.Parallel()
	lookup := published(t, "", `{"nodes": [{"id": "hi", "kind": "transform", "expr": "{ 'hello': input.name }", "unhandled": {"fail": true}}],
	  "input_schema": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string"}}},
	  "sample_input": {"name": "Sam"},
	  "response": {"answers": [{"status": 200, "lines": [{"from": "hi"}]}]}}`)
	id := lookup.Workflow.ID
	def := func(with string) string {
		return `{"nodes": [{"id": "greet", "kind": "http", "unhandled": {"fail": true},
		    "uses": {"workflow": "` + id + `", "revision": 1}, "with": ` + with + `}],
		  "response": {"answers": [{"status": 200, "lines": [{"from": "greet"}]}]},
		  "sample_input": {"who": "Ada"}}`
	}
	if got := problemPointers(create(t, def(`{}`)).Revision.Problems); got != "/nodes/0/with/name required" {
		t.Errorf("problems with no name = %s", got)
	}
	wr := create(t, def(`{"name": "input.who"}`))
	if len(wr.Revision.Problems) > 0 {
		t.Fatalf("problems = %+v", wr.Revision.Problems)
	}

	r := call(t, http.MethodPost, "/v1/preview", `{"definition": `+def(`{"name": "input.who"}`)+`, "node": "greet"}`)
	if pv := strict[gen.Preview](t, r.body); r.status != http.StatusOK || string(pv.Parameters) != `{"name":"Ada"}` ||
		string(pv.Gives) != `{"status":200,"body":{"hello":"Ada"}}` {
		t.Errorf("preview = %d %s", r.status, r.body)
	}

	if r = call(t, http.MethodPost, "/v1/workflows/"+wr.Workflow.ID+"/publish", `{"revision": 1}`); r.status != http.StatusOK {
		t.Fatalf("publish = %d %s", r.status, r.body)
	}
	r = serveWith(t, wr.Workflow.Slug, keyFor(t, wr.Workflow.ID), `{"who": "Ada"}`)
	if r.status != http.StatusOK || string(r.body) != `{"hello":"Ada"}` {
		t.Errorf("serve = %d %s", r.status, r.body)
	}
	r = call(t, http.MethodGet, "/v1/runs?workflow_id="+id, "")
	if runs := strict[gen.RunList](t, r.body).Runs; r.status != http.StatusOK || len(runs) != 1 || runs[0].Trigger != "workflow" ||
		runs[0].Parent == nil || runs[0].Parent.Node != "greet" {
		t.Errorf("lookup's runs = %d %s", r.status, r.body)
	}

	// Itself, and through the workflow that uses it.
	for _, uses := range []string{
		`{"workflow": "` + id + `", "revision": 1}, "with": {"name": "input.name"}`,
		`{"workflow": "` + wr.Workflow.ID + `", "revision": 1}`,
	} {
		draft := `{"nodes": [{"id": "back", "kind": "http", "unhandled": {"fail": true}, "uses": ` + uses + `}],
		  "response": {"answers": [{"status": 200, "lines": [{"from": "back"}]}]}}`
		r = call(t, http.MethodPut, "/v1/workflows/"+id+"/draft", draft, "If-Match", `"`+strconv.Itoa(lastRevision(t, id))+`"`)
		saved := strict[gen.Revision](t, r.body)
		if got := problemPointers(saved.Problems); r.status != http.StatusOK || got != "/nodes/0/uses uses_itself" {
			t.Errorf("a draft that uses %s = %d, problems %s", uses, r.status, got)
		}
		if r = call(t, http.MethodPost, "/v1/workflows/"+id+"/publish", `{"revision": `+strconv.Itoa(saved.Revision)+`}`); r.status != http.StatusUnprocessableEntity {
			t.Errorf("publish what uses itself = %d %s", r.status, r.body)
		}
	}
}

// lastRevision is workflow id's latest revision.
func lastRevision(t *testing.T, id string) int {
	t.Helper()
	r := call(t, http.MethodGet, "/v1/workflows/"+id, "")
	return strict[gen.WorkflowRevision](t, r.body).Workflow.LatestRevision
}

// problemPointers is problems as "pointer code", one per line.
func problemPointers(ps []gen.ProblemError) string {
	var out []string
	for _, p := range ps {
		out = append(out, p.Pointer+" "+p.Code)
	}
	return strings.Join(out, "\n")
}
