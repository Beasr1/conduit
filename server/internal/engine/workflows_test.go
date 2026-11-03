package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/Beasr1/conduit/server/internal/trace"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// callerFunc is a Caller from a function.
type callerFunc func(ctx context.Context, c Call, input json.RawMessage) (Answer, error)

func (f callerFunc) Call(ctx context.Context, c Call, input json.RawMessage) (Answer, error) {
	return f(ctx, c, input)
}

// usesLookup is a node that uses revision n of w-lookup, resolved: its
// answers besides 2xx, a 404, are its outputs.
func usesLookup(t *testing.T, n int) *Program {
	t.Helper()
	var d workflow.Definition
	def := fmt.Sprintf(`{"nodes": [{"id": "find", "kind": "http", "uses": {"workflow": "w-lookup", "revision": %d},
	  "with": {"user_id": "input.id"}, "outputs": [{"status": 404}], "unhandled": {"fail": true}}]}`, n)
	if err := json.Unmarshal([]byte(def), &d); err != nil {
		t.Fatal(err)
	}
	p, err := Compile(&d)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	return p
}

// A node that uses a workflow runs it through the engine's Caller, the
// values it gives its parameters as the input, and answers as the workflow
// answered: with a 2xx, or a status it lists. One it doesn't list, or a run
// that gives no answer, fails the node, beside what it answered with
// (plan 07).
func TestRun_ANodeThatUsesAWorkflow(t *testing.T) {
	t.Parallel()
	var called Call
	var given string
	caller := callerFunc(func(_ context.Context, c Call, input json.RawMessage) (Answer, error) {
		called, given = c, string(input)
		switch c.Revision {
		case 1:
			return Answer{Status: 201, Body: json.RawMessage(`{"name":"Ada"}`)}, nil
		case 2:
			return Answer{Status: 404, Body: json.RawMessage(`{"error":"none"}`)}, nil
		case 3:
			return Answer{Status: 418}, nil
		default:
			return Answer{Status: 502, Body: json.RawMessage(`{"code":"upstream_failed"}`)}, &CallError{Code: CodeTimeout, Detail: "lookup ran out of time"}
		}
	})
	e := testEngine(Options{Workflows: caller})

	res, _ := execute(t, e, usesLookup(t, 1), `{"id": "7"}`)
	n := res.Nodes[0]
	if res.Status != StatusSucceeded || n.HTTPStatus != 201 || string(n.Body) != `{"name":"Ada"}` ||
		called != (Call{Workflow: "w-lookup", Revision: 1, Run: "run-1", Node: "find"}) || given != `{"user_id":"7"}` {
		t.Errorf("run %s, node %+v; called %+v with %s", res.Status, n, called, given)
	}
	res, _ = execute(t, e, usesLookup(t, 2), `{"id": "7"}`)
	if n := res.Nodes[0]; n.Status != StatusSucceeded || n.HTTPStatus != 404 {
		t.Errorf("a listed answer: node %s, %d", n.Status, n.HTTPStatus)
	}
	res, _ = execute(t, e, usesLookup(t, 3), `{"id": "7"}`)
	if n := res.Nodes[0]; n.Status != StatusFailed || Classify(n.Err) != CodeUpstream || !strings.Contains(n.Err.Error(), "418") {
		t.Errorf("an answer it doesn't list: node %s, %v", n.Status, n.Err)
	}
	res, _ = execute(t, e, usesLookup(t, 4), `{"id": "7"}`)
	if n := res.Nodes[0]; n.Status != StatusFailed || Classify(n.Err) != CodeTimeout || n.HTTPStatus != 502 || string(n.Body) != `{"code":"upstream_failed"}` {
		t.Errorf("a run with no answer: node %s, %d %s, %v", n.Status, n.HTTPStatus, n.Body, n.Err)
	}

	// A value that fails fails the node, and nothing is called.
	called = Call{}
	var d workflow.Definition
	if err := json.Unmarshal([]byte(`{"nodes": [{"id": "find", "kind": "http", "uses": {"workflow": "w-lookup", "revision": 1},
	  "with": {"user_id": "$error('bad')"}, "outputs": [{"status": 404}], "unhandled": {"fail": true}}]}`), &d); err != nil {
		t.Fatal(err)
	}
	p, err := Compile(&d)
	if err != nil {
		t.Fatal(err)
	}
	res, _ = execute(t, e, p, `{"id": "7"}`)
	if n := res.Nodes[0]; n.Status != StatusFailed || Classify(n.Err) != CodeWorkflow || called != (Call{}) {
		t.Errorf("a value that fails: node %s, %v; called %+v", n.Status, n.Err, called)
	}

	// With no Caller, the node fails, as ours.
	res, _ = execute(t, testEngine(Options{}), usesLookup(t, 1), `{"id": "7"}`)
	var ce *CallError
	if n := res.Nodes[0]; n.Status != StatusFailed || !errors.As(n.Err, &ce) || ce.Code != CodeInternal {
		t.Errorf("no Caller: node %s, %v", n.Status, n.Err)
	}
}

// greeter answers 200 with a greeting for the user it looks up, or 404
// through the lookup's own 404, and has a sample input of its own.
const greeter = `{"nodes": [
    {"id": "user", "kind": "http", "request": {"method": "GET", "url": "https://u.example.com/{{ input.user_id }}"},
     "sample": {"body": {"name": "Ada"}}, "outputs": [{"status": 404, "sample": {"body": {"error": "none"}}}], "unhandled": {"fail": true}},
    {"id": "greet", "kind": "transform", "expr": "{ 'hello': nodes.user.body.name & ' ' & input.fields }", "unhandled": {"fail": true}}],
  "edges": [{"from": "user", "to": "greet"}],
  "sample_input": {"user_id": "1", "fields": "all"},
  "response": {"answers": [{"status": 200, "lines": [{"from": "greet"}]}, {"status": 404, "lines": [{"from": "user", "on": 404}]}]}}`

// usesGreeter is a definition whose find uses greeter at revision 1, and
// whose after and missing read it on its 2xx and its 404.
const usesGreeter = `{"nodes": [
    {"id": "find", "kind": "http", "uses": {"workflow": "w-greeter", "revision": 1}, "with": {"user_id": "input.id"}, "unhandled": {"fail": true}},
    {"id": "after", "kind": "transform", "expr": "nodes.find", "unhandled": {"fail": true}},
    {"id": "missing", "kind": "transform", "expr": "nodes.find", "unhandled": {"fail": true}}],
  "edges": [{"from": "find", "to": "after"}, {"from": "find", "to": "missing", "on": 404}],
  "sample_input": {"id": "7"}}`

// A node that uses a workflow is previewed by the workflow's own preview,
// over the values it gives, the workflow's sample input standing in for the
// rest: its 2xx answer, or, through another of its answers, that one, which
// from an http node's 404 passes its error on, as a run's does. The preview
// of the node itself says what it gives and what it gets back (plan 07).
func TestSimulate_ANodeThatUsesAWorkflow(t *testing.T) {
	t.Parallel()
	var callee, d workflow.Definition
	for s, v := range map[string]*workflow.Definition{greeter: &callee, usesGreeter: &d} {
		if err := json.Unmarshal([]byte(s), v); err != nil {
			t.Fatal(err)
		}
	}
	deps := workflow.Deps{Revisions: workflow.Revisions{{Workflow: "w-greeter", Revision: 1}: &callee}}
	rd, ps := workflow.Resolve(&d, deps, "")
	if len(ps) > 0 {
		t.Fatalf("Resolve() = %v", ps)
	}
	read := func(id string) (*Preview, string) {
		t.Helper()
		pv, err := Simulate(t.Context(), rd, id, deps)
		if err != nil {
			t.Fatal(err)
		}
		var doc struct {
			Nodes map[string]json.RawMessage `json:"nodes"`
		}
		if err := json.Unmarshal(pv.Reads, &doc); err != nil {
			t.Fatal(err)
		}
		return pv, string(doc.Nodes["find"])
	}
	if pv, find := read("after"); problemCodes(pv) != "" || !sameJSON(t, json.RawMessage(find), `{"status": 200, "headers": {}, "body": {"hello": "Ada all"}}`) {
		t.Errorf("after reads find as %s; problems %s", find, problemCodes(pv))
	}
	if pv, find := read("missing"); problemCodes(pv) != "" || !sameJSON(t, json.RawMessage(find), `{"status": 404, "headers": {},
		"body": {"code": "upstream_failed", "detail": "user answered 404: made up, as a preview calls nothing", "node": "user"}}`) {
		t.Errorf("missing reads find as %s; problems %s", find, problemCodes(pv))
	}
	pv, _ := read("find")
	if !sameJSON(t, pv.Parameters, `{"user_id": "7"}`) || !sameJSON(t, pv.Gives, `{"status": 200, "body": {"hello": "Ada all"}}`) {
		t.Errorf("find gives %s and gets %s", pv.Parameters, pv.Gives)
	}
}

// What a preview can't tell of a workflow a node uses is a problem of the
// node's: an answer the workflow doesn't have, and workflows that use
// workflows deeper than a preview follows.
func TestSimulate_AWorkflowItCantPreview(t *testing.T) {
	t.Parallel()
	var callee, d, deep workflow.Definition
	for s, v := range map[string]*workflow.Definition{
		`{"nodes": []}`: &callee,
		usesGreeter:     &d,
		`{"nodes": [{"id": "again", "kind": "http", "uses": {"workflow": "w-deep", "revision": 1}}],
		  "response": {"answers": [{"status": 200, "lines": [{"from": "again"}]}]}}`: &deep,
	} {
		if err := json.Unmarshal([]byte(s), v); err != nil {
			t.Fatal(err)
		}
	}
	deps := workflow.Deps{Revisions: workflow.Revisions{{Workflow: "w-greeter", Revision: 1}: &callee}}
	rd, _ := workflow.Resolve(&d, deps, "")
	pv, err := Simulate(t.Context(), rd, "find", deps)
	if err != nil || problemCodes(pv) != "/nodes/0/uses missing_sample" || pv.Problems[0].Detail != "find's workflow has no preview of its 2xx answer: it has no response" {
		t.Errorf("Simulate() of a workflow with no response = %v, %v", pv.Problems, err)
	}

	// A workflow that uses itself, as a draft may: the preview stops.
	deps = workflow.Deps{Revisions: workflow.Revisions{{Workflow: "w-deep", Revision: 1}: &deep}}
	rd, _ = workflow.Resolve(&deep, deps, "")
	pv, err = Simulate(t.Context(), rd, "again", deps)
	if err != nil || problemCodes(pv) != "/nodes/0/uses missing_sample" ||
		pv.Problems[0].Detail != "again's workflow has no preview of its 2xx answer: a run refuses it, as the call would pass through Conduit 8 times" {
		t.Errorf("Simulate() of a workflow that uses itself = %v, %v", pv.Problems, err)
	}
}

// A preview follows workflows that use workflows as deep as a run does: a
// run of the draft starts at no hops, and one as many hops in as
// trace.MaxHops is refused (plan 06), so the seventh workflow down is
// previewed and the eighth isn't.
func TestSimulate_AsDeepAsARunGoes(t *testing.T) {
	t.Parallel()
	decode := func(s string) *workflow.Definition {
		var d workflow.Definition
		if err := json.Unmarshal([]byte(s), &d); err != nil {
			t.Fatal(err)
		}
		return &d
	}
	// chain is a draft that uses w1, which uses w2, and so on to wn, which
	// answers.
	chain := func(n int) (*workflow.Definition, workflow.Deps) {
		deps := workflow.Deps{Revisions: workflow.Revisions{
			{Workflow: fmt.Sprintf("w%d", n), Revision: 1}: decode(`{"nodes": [{"id": "hi", "kind": "transform", "expr": "{'hello': 'Ada'}"}],
			  "response": {"answers": [{"status": 200, "lines": [{"from": "hi"}]}]}}`),
		}}
		uses := func(k int) *workflow.Definition {
			return decode(fmt.Sprintf(`{"nodes": [{"id": "call", "kind": "http", "uses": {"workflow": "w%d", "revision": 1}}],
			  "response": {"answers": [{"status": 200, "lines": [{"from": "call"}]}]}}`, k))
		}
		for k := 1; k < n; k++ {
			deps.Revisions[workflow.Uses{Workflow: fmt.Sprintf("w%d", k), Revision: 1}] = uses(k + 1)
		}
		return uses(1), deps
	}
	for n, want := range map[int]string{trace.MaxHops - 1: "", trace.MaxHops: "/nodes/0/uses missing_sample"} {
		d, deps := chain(n)
		rd, ps := workflow.Resolve(d, deps, "")
		if len(ps) > 0 {
			t.Fatalf("Resolve() = %v", ps)
		}
		pv, err := Simulate(t.Context(), rd, "call", deps)
		if err != nil || problemCodes(pv) != want {
			t.Errorf("%d deep: problems %v, %v; want %q", n, pv.Problems, err, want)
		}
	}
}

// answerOf previews what node find, which uses callee, gets through on, 0
// for its 2xx, as a step joined on it reads it; or what says it can't.
func answerOf(t *testing.T, callee string, on int) (got, why string) {
	t.Helper()
	var w, d workflow.Definition
	if err := json.Unmarshal([]byte(callee), &w); err != nil {
		t.Fatal(err)
	}
	edge := `{"from": "find", "to": "then"}`
	if on != 0 {
		edge = fmt.Sprintf(`{"from": "find", "to": "then", "on": %d}`, on)
	}
	def := `{"nodes": [{"id": "find", "kind": "http", "uses": {"workflow": "w", "revision": 1}, "with": {"who": "input.who"}},
	    {"id": "then", "kind": "transform", "expr": "nodes.find"}],
	  "edges": [` + edge + `], "sample_input": {"who": "Ada"}}`
	if err := json.Unmarshal([]byte(def), &d); err != nil {
		t.Fatal(err)
	}
	deps := workflow.Deps{Revisions: workflow.Revisions{{Workflow: "w", Revision: 1}: &w}}
	rd, ps := workflow.Resolve(&d, deps, "")
	if len(ps) > 0 {
		t.Fatalf("Resolve() = %v", ps)
	}
	pv, err := Simulate(t.Context(), rd, "then", deps)
	if err != nil {
		t.Fatal(err)
	}
	if len(pv.Problems) > 0 {
		return "", pv.Problems[0].Detail
	}
	var doc struct {
		Nodes map[string]json.RawMessage `json:"nodes"`
	}
	if err := json.Unmarshal(pv.Reads, &doc); err != nil {
		t.Fatal(err)
	}
	return string(doc.Nodes["find"]), ""
}

// A workflow's answer, previewed, is what a run's would be: a transform
// joined to several answers answers with the one it picks; a line from an
// Unhandled gives its body, or passes the error on, through the error body
// if there is one. What a preview can't tell says why, as a problem of the
// node that uses it (plan 07).
func TestSimulate_WhatAWorkflowAnswers(t *testing.T) {
	t.Parallel()
	transform := func(node, answers string) string {
		return `{"nodes": [` + node + `], "sample_input": {"who": "Sam"}, "response": ` + answers + `}`
	}
	picks := func(expr string, statuses ...int) string {
		var as []string
		for _, s := range statuses {
			as = append(as, fmt.Sprintf(`{"status": %d, "lines": [{"from": "t"}]}`, s))
		}
		return transform(`{"id": "t", "kind": "transform", "expr": "`+expr+`"}`, `{"answers": [`+strings.Join(as, ",")+`]}`)
	}
	fails := func(unhandled, errors string) string {
		return transform(`{"id": "t", "kind": "transform", "expr": "1", "unhandled": `+unhandled+`}`,
			`{"answers": [{"status": 502, "lines": [{"from": "t", "unhandled": true}]}, {"status": 200, "lines": [{"from": "t"}]}]`+errors+`}`)
	}
	for _, c := range []struct {
		name, callee string
		on           int
		got, why     string
	}{
		{
			name: "picks a 2xx", callee: picks("{'status': 201, 'body': {'made': input.who}}", 200, 201),
			got: `{"status": 201, "headers": {}, "body": {"made": "Ada"}}`,
		},
		{
			name: "picks another answer", callee: picks("{'status': 404}", 200, 404),
			why: "find's workflow has no preview of its 2xx answer: with these samples, t picks 404",
		},
		{
			name: "picks nothing", callee: picks("'hi'", 200, 404),
			why: "find's workflow has no preview of its 2xx answer: not an answer: t gave no {status, body} object",
		},
		{
			name: "an Unhandled body", callee: fails(`{"body": "{'sorry': input.who}"}`, ""), on: 502,
			got: `{"status": 502, "headers": {}, "body": {"sorry": "Ada"}}`,
		},
		{
			name: "an error passed on", callee: fails(`{}`, ""), on: 502,
			got: `{"status": 502, "headers": {}, "body": {"code": "workflow_error", "detail": "t failed: made up, as a preview calls nothing", "node": "t"}}`,
		},
		{
			name: "an error passed on, through the error body", callee: fails(`{}`, `, "errors": {"body": "{'oops': error.code, 'who': input.who}"}`), on: 502,
			got: `{"status": 502, "headers": {}, "body": {"oops": "workflow_error", "who": "Ada"}}`,
		},
		{
			name: "an error body that fails", callee: fails(`{}`, `, "errors": {"body": "$error('no')"}`), on: 502,
			why: "find's workflow has no preview of its 502 answer: its error body failed",
		},
		{
			name: "no line", callee: transform(`{"id": "t", "kind": "transform", "expr": "1"}`,
				`{"answers": [{"status": 404, "lines": []}, {"status": 200, "lines": [{"from": "t"}]}]}`), on: 404,
			why: "find's workflow has no preview of its 404 answer: no line joins that answer",
		},
		{
			name: "a line from no step", callee: transform(`{"id": "t", "kind": "transform", "expr": "1"}`,
				`{"answers": [{"status": 200, "lines": [{"from": "ghost"}]}]}`),
			why: "find's workflow has no preview of its 2xx answer: its line comes from no step",
		},
		{
			name: "a step a run skips", callee: `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}, {"id": "b", "kind": "transform", "expr": "2"}],
		    "edges": [{"from": "a", "to": "b", "when": "false"}], "sample_input": {"who": "Sam"},
		    "response": {"answers": [{"status": 200, "lines": [{"from": "b"}]}]}}`,
			why: "find's workflow has no preview of its 2xx answer: with these samples, a run skips its line's step",
		},
		{
			name: "a step on a loop", callee: `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}, {"id": "b", "kind": "transform", "expr": "2"}],
		    "edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "a"}], "sample_input": {"who": "Sam"},
		    "response": {"answers": [{"status": 200, "lines": [{"from": "b"}]}]}}`,
			why: "find's workflow has no preview of its 2xx answer: its line's step is on or after a loop of connections, so it never runs",
		},
	} {
		got, why := answerOf(t, c.callee, c.on)
		switch {
		case c.why != "" && !strings.HasPrefix(why, c.why):
			t.Errorf("%s: says %q, want %q", c.name, why, c.why)
		case c.why == "" && (why != "" || !sameJSON(t, json.RawMessage(got), c.got)):
			t.Errorf("%s: got %s, %q; want %s", c.name, got, why, c.got)
		}
	}
}

// The preview of a node that uses a workflow gives what it gets back, a
// body it doesn't have as null; a value that fails is a problem at its
// place, and the workflow's sample stands in for it.
func TestSimulate_ANodeThatUsesAWorkflowItself(t *testing.T) {
	t.Parallel()
	var callee, d workflow.Definition
	for s, v := range map[string]*workflow.Definition{
		`{"nodes": [{"id": "t", "kind": "transform", "expr": "{'status': input.who = 'Sam' ? 204 : 201}"}], "sample_input": {"who": "Sam"},
		  "response": {"answers": [{"status": 201, "lines": [{"from": "t"}]}, {"status": 204, "lines": [{"from": "t"}]}]}}`: &callee,
		`{"nodes": [{"id": "find", "kind": "http", "uses": {"workflow": "w", "revision": 1}, "with": {"who": "$error('bad')"}},
		    {"id": "then", "kind": "transform", "expr": "nodes.find"}], "edges": [{"from": "find", "to": "then"}]}`: &d,
	} {
		if err := json.Unmarshal([]byte(s), v); err != nil {
			t.Fatal(err)
		}
	}
	deps := workflow.Deps{Revisions: workflow.Revisions{{Workflow: "w", Revision: 1}: &callee}}
	rd, _ := workflow.Resolve(&d, deps, "")
	pv, err := Simulate(t.Context(), rd, "find", deps)
	if err != nil || problemCodes(pv) != "/nodes/0/with/who evaluation_failed" || !sameJSON(t, pv.Gives, `{"status": 204, "body": null}`) {
		t.Errorf("Simulate() = problems %v, gives %s, %v", pv.Problems, pv.Gives, err)
	}
	// So does a step after it, reading it.
	pv, err = Simulate(t.Context(), rd, "then", deps)
	var doc struct {
		Nodes map[string]json.RawMessage `json:"nodes"`
	}
	if err != nil || problemCodes(pv) != "/nodes/0/with/who evaluation_failed" || json.Unmarshal(pv.Reads, &doc) != nil ||
		!sameJSON(t, doc.Nodes["find"], `{"status": 204, "headers": {}, "body": null}`) {
		t.Errorf("Simulate(then) = problems %v, reads %s, %v", pv.Problems, pv.Reads, err)
	}
}

// A revision the preview hasn't got gives nothing, and a step after it
// reads nothing of it: Resolve's problem says why, once.
func TestSimulate_ARevisionItHasntGot(t *testing.T) {
	t.Parallel()
	var d workflow.Definition
	if err := json.Unmarshal([]byte(`{"nodes": [{"id": "find", "kind": "http", "uses": {"workflow": "w", "revision": 9}},
	    {"id": "then", "kind": "transform", "expr": "nodes.find"}], "edges": [{"from": "find", "to": "then"}]}`), &d); err != nil {
		t.Fatal(err)
	}
	rd, ps := workflow.Resolve(&d, workflow.Deps{}, "")
	if len(ps) != 1 || ps[0].Code != "unknown_workflow" {
		t.Fatalf("Resolve() = %v", ps)
	}
	pv, err := Simulate(t.Context(), rd, "find", workflow.Deps{})
	if err != nil || len(pv.Problems) > 0 || pv.Gives != nil {
		t.Errorf("Simulate(find) = problems %v, gives %s, %v", pv.Problems, pv.Gives, err)
	}
	pv, err = Simulate(t.Context(), rd, "then", workflow.Deps{})
	if err != nil || !sameJSON(t, pv.Reads, `{"input": null, "nodes": {}}`) {
		t.Errorf("Simulate(then) reads %s, %v", pv.Reads, err)
	}
}
