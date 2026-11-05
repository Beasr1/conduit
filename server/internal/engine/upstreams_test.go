package engine

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/Beasr1/conduit/server/internal/workflow"
)

// An upstream's version compiles, and its request reads only its
// parameters, by name (plan 07). One that may read what it doesn't name is
// left to run time.
func TestCheckUpstream(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, doc, want string
	}{
		{
			"one that's whole",
			`{"parameters": [{"name": "user_id"}, {"name": "page"}], "request": {"method": "POST",
			  "url": "https://users.example.com/v1/users/{{ user_id }}", "query": {"page": "{{ page.next }}"},
			  "headers": {"X-Who": "{{ user_id }}"}, "body": "{ 'id': user_id }"}}`,
			"",
		},
		{
			"a name that isn't a parameter, wherever it's read",
			`{"parameters": [{"name": "user_id"}], "request": {"method": "POST",
			  "url": "https://users.example.com/v1/users/{{ usr_id }}", "query": {"page": "{{ page }}"},
			  "headers": {"X-Who": "{{ who }}"}, "body": "{ 'id': id }"}}`,
			"/request/body unknown_parameter\n/request/headers/X-Who unknown_parameter\n/request/query/page unknown_parameter\n/request/url unknown_parameter",
		},
		{
			"JSONata that doesn't compile",
			`{"parameters": [{"name": "a"}], "request": {"method": "POST", "url": "https://x.example.com/{{ ( }}", "body": "{",
			  "headers": {"X-A": "{{ ( }}"}}}`,
			"/request/body invalid_expression\n/request/headers/X-A invalid_expression\n/request/url invalid_expression",
		},
		{
			"the whole input, read through a wildcard",
			`{"request": {"method": "POST", "url": "https://x.example.com/v1", "body": "$"}}`,
			"",
		},
		{
			"and what's wrong with it as a version",
			`{"parameters": [{"name": "a"}, {"name": "a"}], "request": {"method": "GET", "url": "https://x.example.com/{{ a }}"}}`,
			"/parameters/1/name duplicate_parameter",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var u workflow.Upstream
			if err := json.Unmarshal([]byte(tt.doc), &u); err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, p := range CheckUpstream(&u, nil) {
				got = append(got, p.Pointer+" "+p.Code)
			}
			slices.Sort(got)
			if g := strings.Join(got, "\n"); g != tt.want {
				t.Errorf("CheckUpstream() =\n%s\nwant\n%s", g, tt.want)
			}
		})
	}
}

// A step's parameter whose expression doesn't compile is a problem, which a
// preview lists rather than failing on.
func TestSimulate_AParameterThatDoesntCompile(t *testing.T) {
	t.Parallel()
	u := workflow.Upstream{
		Parameters: []workflow.Parameter{{Name: "user_id"}},
		Request:    workflow.HTTPRequest{Method: workflow.HTTPRequestMethodGET, URL: "https://users.example.com/v1/users/{{ user_id }}"},
	}
	var d workflow.Definition
	if err := json.Unmarshal([]byte(`{"nodes": [{"id": "user", "kind": "http", "uses": {"upstream": "u", "version": 1}, "with": {"user_id": "("}}]}`), &d); err != nil {
		t.Fatal(err)
	}
	rd, _ := workflow.Resolve(&d, workflow.Deps{Versions: workflow.Versions{{Upstream: "u", Version: 1}: &u}}, "")
	pv, err := Simulate(t.Context(), rd, "user", workflow.Deps{})
	if err != nil || !slices.ContainsFunc(pv.Problems, func(p workflow.Problem) bool { return p.Pointer == "/nodes/0/with/user_id" }) {
		t.Errorf("Simulate() = %+v, %v; want the parameter's problem", pv, err)
	}
}

// A preview of a step that uses an upstream says the values its parameters
// take, which its request reads: one whose value fails is left out, and a
// problem.
func TestSimulate_Parameters(t *testing.T) {
	t.Parallel()
	u := workflow.Upstream{
		Parameters: []workflow.Parameter{{Name: "user_id"}, {Name: "page"}},
		Request:    workflow.HTTPRequest{Method: workflow.HTTPRequestMethodGET, URL: "https://users.example.com/v1/users/{{ user_id }}"},
	}
	var d workflow.Definition
	if err := json.Unmarshal([]byte(`{"sample_input": {"id": "7"}, "nodes": [{"id": "user", "kind": "http",
	  "uses": {"upstream": "u", "version": 1}, "with": {"user_id": "input.id", "page": "input.page"}}]}`), &d); err != nil {
		t.Fatal(err)
	}
	rd, _ := workflow.Resolve(&d, workflow.Deps{Versions: workflow.Versions{{Upstream: "u", Version: 1}: &u}}, "")
	pv, err := Simulate(t.Context(), rd, "user", workflow.Deps{})
	if err != nil || !sameJSON(t, pv.Parameters, `{"user_id": "7"}`) || problemCodes(pv) != "/nodes/0/with/page evaluation_failed" {
		t.Errorf("Simulate() = %s, %s, %v; want user_id's value, and page's problem", pv.Parameters, problemCodes(pv), err)
	}
}

// The words name what was read.
func TestCheckUpstream_Says(t *testing.T) {
	t.Parallel()
	u := workflow.Upstream{
		Parameters: []workflow.Parameter{{Name: "user_id"}},
		Request:    workflow.HTTPRequest{Method: workflow.HTTPRequestMethodGET, URL: "https://users.example.com/v1/users/{{ usr_id }}"},
	}
	want := "it reads usr_id, which isn't one of the upstream's parameters: add it, or fix the name"
	if ps := CheckUpstream(&u, nil); len(ps) != 1 || ps[0].Detail != want {
		t.Errorf("CheckUpstream() = %+v, want one saying %q", []workflow.Problem(ps), want)
	}
}

// A node that uses an upstream evaluates its parameters over the run, then
// renders its version's request over them: the request reads the
// parameters, never the run (plan 07). A parameter with no value fails the
// node, said of its expression.
func TestRun_ANodeThatUsesAnUpstream(t *testing.T) {
	t.Parallel()
	var got struct {
		path, page, who string
		body            []byte
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.path, got.page, got.who = r.URL.Path, r.URL.Query().Get("page"), r.Header.Get("X-Who")
		got.body, _ = io.ReadAll(r.Body)
		fmt.Fprint(w, `{"name": "Ada"}`)
	}))
	t.Cleanup(srv.Close)
	var u workflow.Upstream
	if err := json.Unmarshal([]byte(strings.ReplaceAll(`{"parameters": [{"name": "user_id"}, {"name": "page"}],
	  "request": {"method": "POST", "url": "BASE/users/{{ user_id }}", "query": {"page": "{{ page }}"},
	  "headers": {"X-Who": "{{ user_id }}"}, "body": "{ 'id': user_id }"}}`, "BASE", srv.URL)), &u); err != nil {
		t.Fatal(err)
	}
	vs := workflow.Versions{{Upstream: "u-users", Version: 1}: &u}
	compile := func(with string) *Program {
		t.Helper()
		var d workflow.Definition
		if err := json.Unmarshal([]byte(`{"nodes": [{"id": "user", "kind": "http", "uses": {"upstream": "u-users", "version": 1},
		  "with": `+with+`}]}`), &d); err != nil {
			t.Fatal(err)
		}
		rd, ps := workflow.Resolve(&d, workflow.Deps{Versions: vs}, "")
		if len(ps) > 0 {
			t.Fatalf("Resolve() = %v", ps)
		}
		p, err := Compile(rd, nil)
		if err != nil {
			t.Fatalf("Compile: %v", err)
		}
		return p
	}

	p := compile(`{"user_id": "input.id", "page": "input.page + 1"}`)
	res, _ := execute(t, testEngine(Options{}), p, `{"id": "7", "page": 1}`)
	if res.Status != StatusSucceeded || got.path != "/users/7" || got.page != "2" || got.who != "7" || string(got.body) != `{"id":"7"}` {
		t.Errorf("run %s; sent %s?page=%s, X-Who %q, body %s", res.Status, got.path, got.page, got.who, got.body)
	}

	// A value that's nothing fails the node, and says which.
	res, _ = execute(t, testEngine(Options{}), compile(`{"user_id": "input.missing", "page": "1"}`), `{}`)
	if n := res.Nodes[0]; n.Status != StatusFailed || n.Err == nil || !strings.Contains(n.Err.Error(), "with user_id") {
		t.Errorf("node = %s, %v; want failed, of with user_id", n.Status, n.Err)
	}
}
