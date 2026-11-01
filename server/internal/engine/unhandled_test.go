package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Beasr1/conduit/server/internal/workflow"
)

// A node's Unhandled block takes what its other blocks don't, once a line
// leaves it: a status with no block, a timeout, a body that isn't JSON. The
// node ends failed and the run goes on, the steps after it reading the
// failure as error, beside what the node got back.
func TestRun_UnhandledTakesTheFailure(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /users/7", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Trace", "t-7")
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `{"error": "gone"}`)
	})
	mux.HandleFunc("GET /users/8", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"id": "8"}`)
	})
	mux.HandleFunc("GET /users/slow", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(10 * time.Second):
		}
	})
	mux.HandleFunc("GET /users/html", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<p>not JSON</p>`)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	p := program(t, srv.URL, `{
	  "nodes": [
	    {"id": "user", "kind": "http", "request": {"method": "GET", "url": "BASE/users/{{ input.id }}", "timeout_ms": 50}},
	    {"id": "found", "kind": "transform", "expr": "nodes.user.body.id"},
	    {"id": "missed", "kind": "transform",
	     "expr": "{ 'code': nodes.user.error.code, 'status': nodes.user.status, 'trace': nodes.user.headers.'x-trace', 'body': nodes.user.body }"}
	  ],
	  "edges": [{"from": "user", "to": "found"}, {"from": "user", "to": "missed", "unhandled": true}],
	  "output": "{ 'found': nodes.found.body, 'missed': nodes.missed.body }"
	}`)
	tests := []struct {
		id, nodes, output string
		caught            bool
	}{
		{"8", "user succeeded, found succeeded, missed skipped", `{"found":"8"}`, false},
		{"7", "user failed, found skipped, missed succeeded", `{"missed":{"code":"upstream_failed","status":404,"trace":"t-7","body":{"error":"gone"}}}`, true},
		{"slow", "user failed, found skipped, missed succeeded", `{"missed":{"code":"timeout"}}`, true},
		{"html", "user failed, found skipped, missed succeeded", `{"missed":{"code":"upstream_failed","status":200,"body":null}}`, true},
	}
	for _, tt := range tests {
		t.Run(tt.id, func(t *testing.T) {
			t.Parallel()
			res, rec := execute(t, testEngine(Options{}), p, `{"id": "`+tt.id+`"}`)
			if res.Status != StatusSucceeded || statuses(res) != tt.nodes || string(res.Output) != tt.output {
				t.Errorf("run %s (%s), output %s, err %v; want succeeded (%s), output %s",
					res.Status, statuses(res), res.Output, res.Err, tt.nodes, tt.output)
			}
			if user := res.Nodes[0]; user.Caught != tt.caught || (user.Err != nil) != tt.caught {
				t.Errorf("user caught %v, err %v; want caught %v", user.Caught, user.Err, tt.caught)
			}
			if tt.caught && rec.list(EventFailed) != "user failed" {
				t.Errorf("failed events: %s", rec.list(EventFailed))
			}
		})
	}
}

// With no line from it, a node's Unhandled block takes nothing: the
// failure fails the run, as before.
func TestRun_UnjoinedUnhandledTakesNothing(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	p := program(t, srv.URL, `{
	  "nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/"}}, {"id": "b", "kind": "transform", "expr": "1"}],
	  "edges": [{"from": "a", "to": "b"}]
	}`)
	res, _ := execute(t, testEngine(Options{}), p, `{}`)
	if res.Status != StatusFailed || statuses(res) != "a failed, b cancelled" || res.Nodes[0].Caught {
		t.Errorf("run %s (%s), a caught %v", res.Status, statuses(res), res.Nodes[0].Caught)
	}
}

// A transform's Unhandled block takes its JSONata failing, a case's
// condition among it.
func TestRun_UnhandledTakesATransformsFailure(t *testing.T) {
	t.Parallel()
	p := program(t, "", `{
	  "nodes": [
	    {"id": "count", "kind": "transform", "expr": "$number(input.n)"},
	    {"id": "fallback", "kind": "transform", "expr": "{ 'code': nodes.count.error.code, 'detail': nodes.count.error.detail }"}
	  ],
	  "edges": [{"from": "count", "to": "fallback", "unhandled": true}],
	  "output": "{ 'count': nodes.count.body, 'fallback': nodes.fallback.body }"
	}`)
	res, _ := execute(t, testEngine(Options{}), p, `{"n": "one"}`)
	var out struct {
		Fallback struct{ Code, Detail string }
	}
	if err := json.Unmarshal(res.Output, &out); err != nil {
		t.Fatalf("output %s: %v", res.Output, err)
	}
	if res.Status != StatusSucceeded || statuses(res) != "count failed, fallback succeeded" ||
		out.Fallback.Code != CodeWorkflow || !strings.HasPrefix(out.Fallback.Detail, "expr: ") {
		t.Errorf("run %s (%s), output %s", res.Status, statuses(res), res.Output)
	}
	if res, _ := execute(t, testEngine(Options{}), p, `{"n": "2"}`); string(res.Output) != `{"count":2}` {
		t.Errorf("a number: output %s", res.Output)
	}
}

// Joined straight to an answer, a node's Unhandled block answers with the
// node's body: what an http node got back, and none from a transform.
func TestRun_AnswersThroughUnhandled(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, `{"error": "down"}`)
	}))
	t.Cleanup(srv.Close)
	call := program(t, srv.URL, `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/"}}],
	  "response": {"answers": [{"status": 200, "lines": [{"from": "a"}]}, {"status": 502, "lines": [{"from": "a", "unhandled": true}]}]}}`)
	// With no body of its own, the block passes its error on, for the
	// response's error body (plan 12).
	res, _ := execute(t, testEngine(Options{}), call, `{}`)
	if res.Status != StatusSucceeded || res.Answer != 502 || res.Output != nil || res.ErrorFrom != "a" || !res.Nodes[0].Caught {
		t.Errorf("call: run %s answered %d %s from %q's error, err %v", res.Status, res.Answer, res.Output, res.ErrorFrom, res.Err)
	}
	// A switch's cases each answer, and its Unhandled block, joined to one
	// more, takes its case failing.
	pick := program(t, "", `{"nodes": [{"id": "t", "kind": "transform",
	    "switch": {"cases": [{"when": "$number(input.n) > 1", "status": 400}, {"when": "true", "status": 200}]}}],
	  "response": {"answers": [{"status": 200, "lines": [{"from": "t", "on": 200}]}, {"status": 400, "lines": [{"from": "t", "on": 400}]}, {"status": 500, "lines": [{"from": "t", "unhandled": true}]}]}}`)
	for input, want := range map[string]int{`{"n": "2"}`: 400, `{"n": "0"}`: 200, `{"n": "two"}`: 500} {
		res, _ := execute(t, testEngine(Options{}), pick, input)
		errs := map[int]string{500: "t"}[want]
		if res.Status != StatusSucceeded || res.Answer != want || (want == 500 && res.Output != nil) || res.ErrorFrom != errs {
			t.Errorf("pick %s: run %s answered %d %s from %q's error, err %v; want %d", input, res.Status, res.Answer, res.Output, res.ErrorFrom, res.Err, want)
		}
	}
}

// The lines from Unhandled are lines like any: their conditions read the
// failure, and one that fails fails the run, saying what the block took.
func TestRun_UnhandledLinesTakeConditions(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	a := `{"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/"}}`
	p := program(t, srv.URL, `{
	  "nodes": [`+a+`, {"id": "gone", "kind": "transform", "expr": "'gone'"}, {"id": "other", "kind": "transform", "expr": "'other'"}],
	  "edges": [
	    {"from": "a", "to": "gone", "unhandled": true, "when": "nodes.a.status = 404"},
	    {"from": "a", "to": "other", "unhandled": true, "when": "nodes.a.status != 404"}
	  ],
	  "output": "nodes.gone.body"
	}`)
	res, _ := execute(t, testEngine(Options{}), p, `{}`)
	if res.Status != StatusSucceeded || statuses(res) != "a failed, gone succeeded, other skipped" || string(res.Output) != `"gone"` {
		t.Errorf("run %s (%s), output %s, err %v", res.Status, statuses(res), res.Output, res.Err)
	}
	broken := program(t, srv.URL, `{
	  "nodes": [`+a+`, {"id": "gone", "kind": "transform", "expr": "'gone'"}],
	  "edges": [{"from": "a", "to": "gone", "unhandled": true, "when": "$number('x')"}]
	}`)
	res, _ = execute(t, testEngine(Options{}), broken, `{}`)
	// The condition is the cause, so the run failed as the workflow's fault.
	if res.Status != StatusFailed || statuses(res) != "a failed, gone cancelled" || res.Nodes[0].Caught ||
		!strings.Contains(fmt.Sprint(res.Err), "status 404; then edge to gone: when: ") || Classify(res.Err) != CodeWorkflow {
		t.Errorf("run %s (%s), a caught %v: %v", res.Status, statuses(res), res.Nodes[0].Caught, res.Err)
	}
}

// A step joined to both a node's 2xx and its Unhandled block runs whichever
// the node took.
func TestRun_FollowsANodeEitherWay(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ok", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"n": 1}`) })
	mux.HandleFunc("GET /down", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusBadGateway) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	p := program(t, srv.URL, `{
	  "nodes": [
	    {"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/{{ input.path }}"}},
	    {"id": "either_way", "kind": "transform", "expr": "nodes.a"},
	    {"id": "next", "kind": "transform", "expr": "$exists(nodes.a.error) ? 'missed' : 'got ' & nodes.a.body.n"}
	  ],
	  "edges": [{"from": "a", "to": "either_way"}, {"from": "a", "to": "either_way", "unhandled": true}, {"from": "either_way", "to": "next"}],
	  "output": "nodes.next.body"
	}`)
	for path, want := range map[string]string{"ok": `"got 1"`, "down": `"missed"`} {
		res, _ := execute(t, testEngine(Options{}), p, `{"path": "`+path+`"}`)
		if res.Status != StatusSucceeded || string(res.Output) != want {
			t.Errorf("%s: run %s (%s), output %s, err %v; want %s", path, res.Status, statuses(res), res.Output, res.Err, want)
		}
	}
}

// Unhandled never takes the run's own end: a panic, which is our bug, and
// the run's deadline.
func TestRun_UnhandledLeavesTheRunsOwnEnd(t *testing.T) {
	t.Parallel()
	def := `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/"}}, {"id": "b", "kind": "transform", "expr": "1"}],
	  "edges": [{"from": "a", "to": "b", "unhandled": true}]}`
	// A nil client panics the moment an http node calls it.
	res, _ := execute(t, New(nil, Options{}), program(t, "http://x.example", def), `{}`)
	var pe *PanicError
	if res.Status != StatusFailed || res.Nodes[0].Caught || !errors.As(res.Nodes[0].Err, &pe) {
		t.Errorf("panic: run %s, a caught %v, err %v", res.Status, res.Nodes[0].Caught, res.Nodes[0].Err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(10 * time.Second):
		}
	}))
	t.Cleanup(srv.Close)
	res, _ = execute(t, testEngine(Options{RunTimeout: 100 * time.Millisecond}), program(t, srv.URL, def), `{}`)
	if res.Status != StatusFailed || !errors.Is(res.Err, ErrRunTimeout) || res.Nodes[0].Caught || statuses(res) != "a failed, b cancelled" {
		t.Errorf("deadline: run %s (%s), a caught %v: %v", res.Status, statuses(res), res.Nodes[0].Caught, res.Err)
	}
}

// The response's Unhandled reads a node whose Unhandled block took its
// failure, as the steps after it do.
func TestProgram_UnhandledReadsCaughtNodes(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	p := program(t, srv.URL, `{
	  "nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/"}}, {"id": "b", "kind": "transform", "expr": "$number('one')"}],
	  "edges": [{"from": "a", "to": "b", "unhandled": true}],
	  "response": {"answers": [{"status": 200, "lines": [{"from": "b"}]}],
	    "errors": {"body": "{ 'a': nodes.a.error.code, 'status': nodes.a.status, 'failed': error.node }"}}
	}`)
	res, _ := execute(t, testEngine(Options{}), p, `{}`)
	if res.Status != StatusFailed || statuses(res) != "a failed, b failed" {
		t.Fatalf("run %s (%s): %v", res.Status, statuses(res), res.Err)
	}
	body, ok, err := p.ErrorBody(t.Context(), nil, res.Nodes, json.RawMessage(`{"code": "workflow_error", "detail": "…", "node": "b"}`))
	if !ok || err != nil || string(body) != `{"a":"upstream_failed","status":404,"failed":"b"}` {
		t.Errorf("Unhandled() = %s, %v, %v", body, ok, err)
	}
}

// failing has an http step whose Unhandled block alone leads to the step
// after it, and a transform's that leads to the output.
const failing = `{
  "nodes": [
    {"id": "user", "kind": "http", "request": {"method": "GET", "url": "https://users.example.com/v1/users/{{ input.id }}"},
     "sample": {"body": {"id": "7"}}},
    {"id": "fallback", "kind": "transform", "expr": "{ 'code': nodes.user.error.code, 'id': nodes.user.body.id }"},
    {"id": "check", "kind": "transform", "expr": "$number('one')"},
    {"id": "after", "kind": "transform", "expr": "nodes.check.error.code"}
  ],
  "edges": [
    {"from": "user", "to": "fallback", "unhandled": true},
    {"from": "fallback", "to": "check"},
    {"from": "check", "to": "after", "unhandled": true}
  ],
  "sample_input": {"id": "7"}
}`

// A preview of a step only an Unhandled block leads to has that block's
// node fail, with an error made up, as no call is made.
func TestSimulate_FailsIntoUnhandled(t *testing.T) {
	t.Parallel()
	pv := previewOf(t, failing, "fallback", nil)
	if pv.Skipped || problemCodes(pv) != "" || !sameJSON(t, pv.Gives, `{"code": "upstream_failed"}`) ||
		!strings.Contains(string(pv.Reads), `"user failed: made up, as a preview calls nothing"`) {
		t.Errorf("fallback: skipped %v, gives %s, reads %s, problems %s", pv.Skipped, pv.Gives, pv.Reads, problemCodes(pv))
	}
	if pv := previewOf(t, failing, "after", nil); pv.Skipped || !sameJSON(t, pv.Gives, `"workflow_error"`) {
		t.Errorf("after: skipped %v, gives %s, problems %s", pv.Skipped, pv.Gives, problemCodes(pv))
	}
	// An output leading there too comes first: user's 2xx and Unhandled into
	// a transform that fallback follows.
	pv = previewOf(t, failing, "fallback", func(d *workflow.Definition) {
		d.Nodes = append(d.Nodes, workflow.Node{ID: "either_way", Kind: workflow.NodeKindTransform, Expr: "nodes.user"})
		d.Edges[0] = workflow.Edge{From: "user", To: "either_way", Unhandled: true}
		d.Edges = append(d.Edges, workflow.Edge{From: "user", To: "either_way"}, workflow.Edge{From: "either_way", To: "fallback"})
	})
	if !sameJSON(t, pv.Gives, `{"id": "7"}`) {
		t.Errorf("with a 2xx line too: gives %s", pv.Gives)
	}
	// A connection from Unhandled reads the made-up failure.
	pv = edgePreviewOf(t, failing, 0, nil)
	if taken(pv) != "true" || !strings.Contains(string(pv.Reads), `"error":{"code":"upstream_failed"`) {
		t.Errorf("edge: taken %s, reads %s, problems %s", taken(pv), pv.Reads, problemCodes(pv))
	}
}

// A step's Unhandled body gives its value once the block takes its failure:
// on a transform, a fallback, as a catch's return.
func TestRun_UnhandledBodyGivesAFallback(t *testing.T) {
	t.Parallel()
	p := program(t, "", `{
	  "nodes": [
	    {"id": "count", "kind": "transform", "expr": "$number(input.n)", "unhandled": {"body": "0"}},
	    {"id": "either_way", "kind": "transform", "expr": "nodes.count"},
	    {"id": "next", "kind": "transform", "expr": "nodes.count.body + 1"}
	  ],
	  "edges": [{"from": "count", "to": "either_way"}, {"from": "count", "to": "either_way", "unhandled": true}, {"from": "either_way", "to": "next"}],
	  "output": "nodes.next.body"
	}`)
	for input, want := range map[string]string{`{"n": "2"}`: "3", `{"n": "two"}`: "1"} {
		res, _ := execute(t, testEngine(Options{}), p, input)
		if res.Status != StatusSucceeded || string(res.Output) != want {
			t.Errorf("%s: run %s (%s), output %s, err %v; want %s", input, res.Status, statuses(res), res.Output, res.Err, want)
		}
	}
	res, _ := execute(t, testEngine(Options{}), p, `{"n": "two"}`)
	if count := res.Nodes[0]; !count.Caught || string(count.Gave) != "0" || count.Body != nil {
		t.Errorf("count caught %v, gave %s, body %s", count.Caught, count.Gave, count.Body)
	}
}

// On an http step, what the body gives is what the steps after read as its
// body, and what an answer joined straight to the block answers with; its
// status, headers and error stay.
func TestRun_UnhandledBodyShapesWhatFollows(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `{"error": "gone"}`)
	}))
	t.Cleanup(srv.Close)
	user := `{"id": "user", "kind": "http", "request": {"method": "GET", "url": "BASE/"},
	  "unhandled": {"body": "{ 'missing': nodes.user.status, 'why': nodes.user.body.error }"}}`
	answer := program(t, srv.URL, `{"nodes": [`+user+`],
	  "response": {"answers": [{"status": 200, "lines": [{"from": "user"}]}, {"status": 404, "lines": [{"from": "user", "unhandled": true}]}]}}`)
	res, _ := execute(t, testEngine(Options{}), answer, `{}`)
	if res.Status != StatusSucceeded || res.Answer != 404 || string(res.Output) != `{"missing":404,"why":"gone"}` {
		t.Errorf("answer: run %s answered %d %s, err %v", res.Status, res.Answer, res.Output, res.Err)
	}
	if string(res.Nodes[0].Body) != `{"error": "gone"}` {
		t.Errorf("user's body as it got it: %s", res.Nodes[0].Body)
	}
	after := program(t, srv.URL, `{"nodes": [`+user+`,
	    {"id": "next", "kind": "transform", "expr": "{ 'body': nodes.user.body, 'status': nodes.user.status, 'code': nodes.user.error.code }"}],
	  "edges": [{"from": "user", "to": "next", "unhandled": true}],
	  "output": "nodes.next.body"}`)
	res, _ = execute(t, testEngine(Options{}), after, `{}`)
	if string(res.Output) != `{"body":{"missing":404,"why":"gone"},"status":404,"code":"upstream_failed"}` {
		t.Errorf("after: run %s, output %s, err %v", res.Status, res.Output, res.Err)
	}
	// The response's Unhandled reads it too.
	failing := program(t, srv.URL, `{"nodes": [`+user+`, {"id": "b", "kind": "transform", "expr": "$number('one')"}],
	  "edges": [{"from": "user", "to": "b", "unhandled": true}],
	  "response": {"answers": [{"status": 200, "lines": [{"from": "b"}]}], "errors": {"body": "nodes.user.body"}}}`)
	res, _ = execute(t, testEngine(Options{}), failing, `{}`)
	body, ok, err := failing.ErrorBody(t.Context(), nil, res.Nodes, json.RawMessage(`{"code": "workflow_error", "detail": "…", "node": "b"}`))
	if !ok || err != nil || string(body) != `{"missing":404,"why":"gone"}` {
		t.Errorf("Unhandled() = %s, %v, %v", body, ok, err)
	}
}

// An Unhandled body that fails fails the run, saying what the block took,
// and the body is the cause, the workflow's fault.
func TestRun_UnhandledBodyThatFails(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	p := program(t, srv.URL, `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/"}, "unhandled": {"body": "$number('x')"}},
	    {"id": "b", "kind": "transform", "expr": "1"}],
	  "edges": [{"from": "a", "to": "b", "unhandled": true}]}`)
	res, _ := execute(t, testEngine(Options{}), p, `{}`)
	if res.Status != StatusFailed || statuses(res) != "a failed, b cancelled" || res.Nodes[0].Caught ||
		!strings.Contains(fmt.Sprint(res.Err), "status 404; then unhandled: body: ") || Classify(res.Err) != CodeWorkflow {
		t.Errorf("run %s (%s), a caught %v: %v", res.Status, statuses(res), res.Nodes[0].Caught, res.Err)
	}
}

// A preview of a step's Unhandled body reads the step failing, an error made
// up; a step after the block reads what the body gives.
func TestSimulate_UnhandledBody(t *testing.T) {
	t.Parallel()
	def := `{
	  "nodes": [
	    {"id": "user", "kind": "http", "request": {"method": "GET", "url": "https://users.example.com/v1"},
	     "sample": {"body": {"id": "7"}}, "unhandled": {"body": "{ 'why': nodes.user.error.code }"}},
	    {"id": "fallback", "kind": "transform", "expr": "nodes.user.body"}
	  ],
	  "edges": [{"from": "user", "to": "fallback", "unhandled": true}]
	}`
	pv := previewOf(t, def, "user", nil)
	if pv.Unhandled == nil || !sameJSON(t, pv.Unhandled.Gives, `{"why": "upstream_failed"}`) ||
		!strings.Contains(string(pv.Unhandled.Reads), `"user":{"error":{"code":"upstream_failed"`) || problemCodes(pv) != "" {
		t.Errorf("user: unhandled %+v, problems %s", pv.Unhandled, problemCodes(pv))
	}
	if pv := previewOf(t, def, "fallback", nil); !sameJSON(t, pv.Gives, `{"why": "upstream_failed"}`) {
		t.Errorf("fallback gives %s, problems %s", pv.Gives, problemCodes(pv))
	}
	// One that fails says where, and so does a step after it.
	broken := func(d *workflow.Definition) { d.Nodes[0].Unhandled.Body = "$number('x')" }
	if pv := previewOf(t, def, "user", broken); pv.Unhandled == nil || pv.Unhandled.Gives != nil ||
		problemCodes(pv) != "/nodes/0/unhandled/body evaluation_failed" {
		t.Errorf("a broken body: unhandled %+v, problems %s", pv.Unhandled, problemCodes(pv))
	}
	// fallback then has no user to read either.
	if pv := previewOf(t, def, "fallback", broken); problemCodes(pv) != "/nodes/0/unhandled/body evaluation_failed, /nodes/1/expr evaluation_failed" {
		t.Errorf("after a broken body: problems %s", problemCodes(pv))
	}
	// A step without one has none to preview.
	if pv := previewOf(t, def, "fallback", nil); pv.Unhandled != nil {
		t.Errorf("fallback's unhandled %+v", pv.Unhandled)
	}
}
