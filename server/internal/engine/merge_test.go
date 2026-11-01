package engine

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/Beasr1/conduit/server/internal/workflow"
)

// A transform runs once every edge into it has ended, if any was taken, and
// gives what its expr makes of whatever came. prefs answers 2xx or 400; on
// 400, fallback gets them another way.
func TestRun_ATransformMergesItsLines(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /prefs/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("id") == "new" {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"error": "no prefs yet"}`)
			return
		}
		fmt.Fprint(w, `{"theme": "dark"}`)
	})
	mux.HandleFunc("GET /defaults", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"data": {"theme": "light"}}`)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	p := program(t, srv.URL, `{
	  "nodes": [
	    {"id": "prefs", "kind": "http", "request": {"method": "GET", "url": "BASE/prefs/{{ input.id }}"}, "outputs": [{"status": 400}]},
	    {"id": "fallback", "kind": "http", "request": {"method": "GET", "url": "BASE/defaults"}},
	    {"id": "prefs_ok", "kind": "transform", "expr": "$exists(nodes.fallback) ? nodes.fallback.body.data : nodes.prefs.body"},
	    {"id": "greet", "kind": "transform", "expr": "'theme: ' & nodes.prefs_ok.body.theme"}
	  ],
	  "edges": [
	    {"from": "prefs", "to": "prefs_ok"},
	    {"from": "prefs", "to": "fallback", "on": 400},
	    {"from": "fallback", "to": "prefs_ok"},
	    {"from": "prefs_ok", "to": "greet"}
	  ],
	  "response": {"answers": [{"status": 200, "from": "greet"}]}
	}`)
	tests := []struct {
		id, nodes, output string
		ways              []Way
	}{
		{"7", "prefs succeeded, fallback skipped, prefs_ok succeeded, greet succeeded", `"theme: dark"`, []Way{{From: "prefs"}}},
		{"new", "prefs succeeded, fallback succeeded, prefs_ok succeeded, greet succeeded", `"theme: light"`, []Way{{From: "fallback"}}},
	}
	for _, tt := range tests {
		t.Run(tt.id, func(t *testing.T) {
			t.Parallel()
			res, rec := execute(t, testEngine(Options{}), p, `{"id": "`+tt.id+`"}`)
			if res.Status != StatusSucceeded || statuses(res) != tt.nodes || res.Answer != http.StatusOK || string(res.Output) != tt.output {
				t.Errorf("run %s (%s), answer %d %s, err %v; want succeeded (%s), 200 %s",
					res.Status, statuses(res), res.Answer, res.Output, res.Err, tt.nodes, tt.output)
			}
			if w := res.Nodes[2].Ways; !slices.Equal(w, tt.ways) {
				t.Errorf("prefs_ok's ways = %v, want %v", w, tt.ways)
			}
			// The event that ends it carries them too.
			for _, e := range rec.events {
				if e.Node == "prefs_ok" && e.Kind == EventSucceeded && !slices.Equal(e.Result.Ways, tt.ways) {
					t.Errorf("prefs_ok's last event carries the ways %v, want %v", e.Result.Ways, tt.ways)
				}
			}
		})
	}
}

// Every way that came counts, two at once among them; the expr reads the
// steps before it by name, and a step that didn't run is missing. With none,
// the transform is skipped, and so are the steps after it. One no line comes
// into runs first, and comes by none.
func TestRun_ATransformTakesWhateverCame(t *testing.T) {
	t.Parallel()
	p := program(t, "", `{
	  "nodes": [
	    {"id": "in", "kind": "transform", "expr": "input"},
	    {"id": "a", "kind": "transform", "expr": "'a'"},
	    {"id": "b", "kind": "transform", "expr": "'b'"},
	    {"id": "e", "kind": "transform", "expr": "{ 'a': nodes.a.body, 'b': nodes.b.body }"},
	    {"id": "after", "kind": "transform", "expr": "nodes.e.body"}
	  ],
	  "edges": [
	    {"from": "in", "to": "a", "when": "nodes.in.body.a"},
	    {"from": "in", "to": "b", "when": "nodes.in.body.b"},
	    {"from": "a", "to": "e"}, {"from": "b", "to": "e"},
	    {"from": "e", "to": "after"}
	  ],
	  "output": "{ 'after': nodes.after.body }"
	}`)
	tests := []struct {
		input, nodes, output string
		ways                 []Way
	}{
		{`{"a": true, "b": true}`, "in succeeded, a succeeded, b succeeded, e succeeded, after succeeded", `{"after":{"a":"a","b":"b"}}`, []Way{{From: "a"}, {From: "b"}}},
		{`{"a": false, "b": true}`, "in succeeded, a skipped, b succeeded, e succeeded, after succeeded", `{"after":{"b":"b"}}`, []Way{{From: "b"}}},
		{`{"a": false, "b": false}`, "in succeeded, a skipped, b skipped, e skipped, after skipped", `{}`, nil},
	}
	for _, tt := range tests {
		res, _ := execute(t, testEngine(Options{}), p, tt.input)
		if res.Status != StatusSucceeded || statuses(res) != tt.nodes || string(res.Output) != tt.output || !slices.Equal(res.Nodes[3].Ways, tt.ways) {
			t.Errorf("%s: run %s (%s), output %s, ways %v, err %v; want %s, %s, %v",
				tt.input, res.Status, statuses(res), res.Output, res.Nodes[3].Ways, res.Err, tt.nodes, tt.output, tt.ways)
		}
		if w := res.Nodes[0].Ways; w != nil {
			t.Errorf("%s: in, with no line into it, came by %v", tt.input, w)
		}
	}
}

// A transform's expr failing fails it, and its Unhandled block takes that,
// as it takes any node's failure; the ways that came are recorded all the
// same.
func TestRun_ATransformsExprThatFails(t *testing.T) {
	t.Parallel()
	p := program(t, "", `{
	  "nodes": [
	    {"id": "a", "kind": "transform", "expr": "'x'"},
	    {"id": "e", "kind": "transform", "expr": "$number(nodes.a.body)"},
	    {"id": "caught", "kind": "transform", "expr": "nodes.e.error"}
	  ],
	  "edges": [{"from": "a", "to": "e"}, {"from": "e", "to": "caught", "unhandled": true}],
	  "output": "nodes.caught.body"
	}`)
	res, _ := execute(t, testEngine(Options{}), p, `{}`)
	if res.Status != StatusSucceeded || !strings.HasPrefix(string(res.Output), `{"code":"workflow_error","detail":"expr: `) {
		t.Errorf("run %s (%s), output %s, err %v", res.Status, statuses(res), res.Output, res.Err)
	}
	if e := res.Nodes[1]; e.Status != StatusFailed || !e.Caught || !slices.Equal(e.Ways, []Way{{From: "a"}}) {
		t.Errorf("e %s, caught %v, ways %v", e.Status, e.Caught, e.Ways)
	}
}

// A transform joined to a step's Unhandled records the way it came by as
// that.
func TestRun_ATransformRecordsAnUnhandledWay(t *testing.T) {
	t.Parallel()
	p := program(t, "", `{
	  "nodes": [
	    {"id": "count", "kind": "transform", "expr": "$number(input.n)"},
	    {"id": "e", "kind": "transform", "expr": "$exists(nodes.count.error) ? 0 : nodes.count.body"}
	  ],
	  "edges": [{"from": "count", "to": "e"}, {"from": "count", "to": "e", "unhandled": true}],
	  "output": "nodes.e.body"
	}`)
	for n, want := range map[string]struct {
		output string
		ways   []Way
	}{
		`"2"`: {"2", []Way{{From: "count"}}},
		`"x"`: {"0", []Way{{From: "count", On: workflow.OnUnhandled}}},
	} {
		res, _ := execute(t, testEngine(Options{}), p, `{"n": `+n+`}`)
		if string(res.Output) != want.output || !slices.Equal(res.Nodes[1].Ways, want.ways) {
			t.Errorf("n %s: output %s (%v), ways %v; want %s, %v", n, res.Output, res.Err, res.Nodes[1].Ways, want.output, want.ways)
		}
	}
}

// merged is prefs, falling back on fallback on 400, the two joined in
// prefs_ok, with a sample for each response.
const merged = `{
  "nodes": [
    {"id": "prefs", "kind": "http", "request": {"method": "GET", "url": "https://prefs.example.com/v1/7"},
     "sample": {"body": {"theme": "dark"}}, "outputs": [{"status": 400, "sample": {"body": {"error": "no prefs yet"}}}]},
    {"id": "fallback", "kind": "http", "request": {"method": "GET", "url": "https://prefs.example.com/v1/defaults"},
     "sample": {"body": {"data": {"theme": "light"}}}},
    {"id": "prefs_ok", "kind": "transform", "expr": "$exists(nodes.fallback) ? nodes.fallback.body.data : nodes.prefs.body"},
    {"id": "greet", "kind": "transform", "expr": "'theme: ' & nodes.prefs_ok.body.theme"}
  ],
  "edges": [
    {"from": "prefs", "to": "prefs_ok"},
    {"from": "prefs", "to": "fallback", "on": 400},
    {"from": "fallback", "to": "prefs_ok"},
    {"from": "prefs_ok", "to": "greet"}
  ]
}`

// A step after a transform previews it over the way previews take, 2xx
// first; with no way taken, the transform is skipped, and so is the step.
func TestSimulate_ATransformThatMerges(t *testing.T) {
	t.Parallel()
	if pv := previewOf(t, merged, "greet", nil); !sameJSON(t, pv.Gives, `"theme: dark"`) || problemCodes(pv) != "" {
		t.Errorf("greet gives %s, problems %s", pv.Gives, problemCodes(pv))
	}
	pv := previewOf(t, merged, "greet", func(d *workflow.Definition) { d.Edges[0].When = "false" })
	if !pv.Skipped {
		t.Errorf("no way taken: greet skipped %v, gives %s", pv.Skipped, pv.Gives)
	}
}

// A transform with two or more lines that aren't required previews a run by
// each: the steps before that line's step answer through the outputs that
// lead to it, so fallback's run reads prefs' 400 sample and fallback's. Its
// Input is what those runs read, merged, a step read differently by two as
// the first read it; each run gives its own value.
func TestSimulate_ATransformsWays(t *testing.T) {
	t.Parallel()
	pv := previewOf(t, merged, "prefs_ok", nil)
	if problemCodes(pv) != "" || pv.Gives != nil || pv.Skipped || len(pv.Ways) != 2 ||
		pv.Ways[0].Edge != 0 || pv.Ways[0].Skipped || !sameJSON(t, pv.Ways[0].Gives, `{"theme": "dark"}`) ||
		pv.Ways[1].Edge != 2 || pv.Ways[1].Skipped || !sameJSON(t, pv.Ways[1].Gives, `{"theme": "light"}`) {
		t.Errorf("prefs_ok: problems %s, gives %s, skipped %v, ways %+v", problemCodes(pv), pv.Gives, pv.Skipped, pv.Ways)
	}
	if !sameJSON(t, pv.Reads, `{"input": null, "nodes": {
	    "prefs": {"status": 200, "headers": {}, "body": {"theme": "dark"}},
	    "fallback": {"status": 200, "headers": {}, "body": {"data": {"theme": "light"}}}}}`) {
		t.Errorf("prefs_ok reads %s", pv.Reads)
	}
	// A way whose condition doesn't hold over the samples isn't taken; with
	// none taken, the transform is skipped.
	pv = previewOf(t, merged, "prefs_ok", func(d *workflow.Definition) { d.Edges[2].When = "false" })
	if len(pv.Ways) != 2 || pv.Ways[0].Skipped || !pv.Ways[1].Skipped || pv.Ways[1].Gives != nil || pv.Skipped {
		t.Errorf("fallback's line false: skipped %v, ways %+v", pv.Skipped, pv.Ways)
	}
	// Its Unhandled body isn't previewed then: no run starts it.
	pv = previewOf(t, merged, "prefs_ok", func(d *workflow.Definition) {
		d.Edges[0].When, d.Edges[2].When = "false", "false"
		d.Nodes[2].Unhandled = &workflow.NodeUnhandled{Body: "1"}
	})
	if len(pv.Ways) != 2 || !pv.Ways[0].Skipped || !pv.Ways[1].Skipped || !pv.Skipped || pv.Unhandled != nil {
		t.Errorf("both lines false: skipped %v, ways %+v, unhandled %+v", pv.Skipped, pv.Ways, pv.Unhandled)
	}
	// A problem in the way of both runs is listed once.
	pv = previewOf(t, merged, "prefs_ok", func(d *workflow.Definition) { d.Nodes[0].Request.Method = "BREW" })
	if got := problemCodes(pv); got != "/nodes/0/request/method invalid_method" {
		t.Errorf("a problem in both runs: %s", got)
	}
	// With the line from fallback required, there's one way left that may
	// not come, so one run, which comes by the required line: prefs answers
	// 400, and fallback runs.
	fallback := func(d *workflow.Definition) { d.Edges[2].Required = true }
	pv = previewOf(t, merged, "prefs_ok", fallback)
	if pv.Ways != nil || pv.Skipped || !sameJSON(t, pv.Gives, `{"theme": "light"}`) {
		t.Errorf("fallback required: skipped %v, gives %s, ways %+v", pv.Skipped, pv.Gives, pv.Ways)
	}
	// A step after it comes by its required line too, and so does a
	// connection out of it.
	if pv := previewOf(t, merged, "greet", fallback); pv.Skipped || !sameJSON(t, pv.Gives, `"theme: light"`) {
		t.Errorf("greet, fallback required: skipped %v, gives %s", pv.Skipped, pv.Gives)
	}
	if pv := edgePreviewOf(t, merged, 3, fallback); pv.Skipped || pv.Taken == nil || !*pv.Taken {
		t.Errorf("prefs_ok to greet, fallback required: skipped %v, taken %v", pv.Skipped, pv.Taken)
	}
	// Its Unhandled body reads the runs merged, with its failure made up.
	pv = previewOf(t, merged, "prefs_ok", func(d *workflow.Definition) {
		d.Nodes[2].Unhandled = &workflow.NodeUnhandled{Body: "nodes.fallback.body.data"}
	})
	if pv.Unhandled == nil || !sameJSON(t, pv.Unhandled.Gives, `{"theme": "light"}`) ||
		!strings.Contains(string(pv.Unhandled.Reads), `"prefs_ok":{"error"`) {
		t.Errorf("prefs_ok's Unhandled: %+v", pv.Unhandled)
	}
	// A way from a step's Unhandled comes with that step failing, an error
	// made up; its 2xx, with it answering.
	counted := `{"nodes": [{"id": "count", "kind": "transform", "expr": "$number(input.n)"},
	    {"id": "e", "kind": "transform", "expr": "$exists(nodes.count.error) ? 0 : nodes.count.body"}],
	  "edges": [{"from": "count", "to": "e"}, {"from": "count", "to": "e", "unhandled": true}], "sample_input": {"n": "2"}}`
	if pv := previewOf(t, counted, "e", nil); len(pv.Ways) != 2 || !sameJSON(t, pv.Ways[0].Gives, `2`) || !sameJSON(t, pv.Ways[1].Gives, `0`) {
		t.Errorf("e: ways %+v, problems %s", pv.Ways, problemCodes(pv))
	}
}

// A preview comes by the required lines into each transform it runs, the
// steps before each answering as they must for it to come, but one whose
// end names no step leads nowhere, and so does one into an http node, as
// only a transform's are marked. The output's preview has every http step
// answer 2xx, whatever a transform requires.
func TestSimulate_RequiredLinesCome(t *testing.T) {
	t.Parallel()
	// fallback's line needs prefs to answer 400, c's needs nothing.
	pv := previewOf(t, merged, "prefs_ok", func(d *workflow.Definition) {
		d.Nodes = append(d.Nodes, workflow.Node{ID: "c", Kind: workflow.NodeKindTransform, Expr: "'c'"})
		d.Edges[2].Required = true
		d.Edges = append(d.Edges, workflow.Edge{From: "c", To: "prefs_ok", Required: true})
	})
	if pv.Skipped || !sameJSON(t, pv.Gives, `{"theme": "light"}`) {
		t.Errorf("two required lines: skipped %v, gives %s, problems %s", pv.Skipped, pv.Gives, problemCodes(pv))
	}
	marked := `{"nodes": [
	    {"id": "a", "kind": "http", "request": {"method": "GET", "url": "https://a.example.com/v1"}, "sample": {"body": "ok"},
	     "outputs": [{"status": 404, "sample": {"body": "gone"}}]},
	    {"id": "h", "kind": "http", "request": {"method": "GET", "url": "https://h.example.com/v1"}, "sample": {"body": "h"}},
	    {"id": "x", "kind": "transform", "expr": "$exists(nodes.h) ? 'by h' : 'by a'"},
	    {"id": "t", "kind": "transform", "expr": "nodes.x.body"}],
	  "edges": [{"from": "a", "to": "h", "on": 404, "required": true}, {"from": "a", "to": "x"}, {"from": "h", "to": "x"},
	    {"from": "x", "to": "t"}]}`
	if pv := previewOf(t, marked, "t", nil); !sameJSON(t, pv.Gives, `"by a"`) {
		t.Errorf("a required line into an http node: t gives %s, problems %s", pv.Gives, problemCodes(pv))
	}
	count := `{"nodes": [{"id": "count", "kind": "transform", "expr": "$number(input.n)"},
	    {"id": "e", "kind": "transform", "expr": "$exists(nodes.count.error) ? 'failed' : 'ok'"}],
	  "edges": [{"from": "count", "to": "e"}, {"from": "nope", "to": "e", "unhandled": true, "required": true}],
	  "sample_input": {"n": "2"}}`
	if pv := previewOf(t, count, "e", nil); !sameJSON(t, pv.Gives, `"ok"`) {
		t.Errorf("a required line from no step: e gives %s, problems %s", pv.Gives, problemCodes(pv))
	}
	pv = previewOf(t, merged, "", func(d *workflow.Definition) {
		d.Edges[2].Required = true
		d.Output = "nodes.prefs.status"
	})
	if !sameJSON(t, pv.Gives, `200`) {
		t.Errorf("the output, fallback required: gives %s, problems %s", pv.Gives, problemCodes(pv))
	}
}

// A line into a transform marked required has to come, or the transform is
// skipped, as a line into an http node; the others may not.
func TestRun_RequiredLines(t *testing.T) {
	t.Parallel()
	p := program(t, "", `{
	  "nodes": [
	    {"id": "in", "kind": "transform", "expr": "input"},
	    {"id": "a", "kind": "transform", "expr": "'a'"},
	    {"id": "b", "kind": "transform", "expr": "'b'"},
	    {"id": "t", "kind": "transform", "expr": "[nodes.a.body, nodes.b.body]"}
	  ],
	  "edges": [
	    {"from": "in", "to": "a", "when": "nodes.in.body.a"},
	    {"from": "in", "to": "b", "when": "nodes.in.body.b"},
	    {"from": "a", "to": "t", "required": true}, {"from": "b", "to": "t"}
	  ],
	  "output": "$exists(nodes.t) ? nodes.t.body : null"
	}`)
	for input, want := range map[string]string{
		`{"a": true, "b": true}`:   `in succeeded, a succeeded, b succeeded, t succeeded ["a","b"]`,
		`{"a": true, "b": false}`:  `in succeeded, a succeeded, b skipped, t succeeded ["a"]`,
		`{"a": false, "b": true}`:  `in succeeded, a skipped, b succeeded, t skipped null`,
		`{"a": false, "b": false}`: `in succeeded, a skipped, b skipped, t skipped null`,
	} {
		res, _ := execute(t, testEngine(Options{}), p, input)
		if got := statuses(res) + " " + string(res.Output); res.Status != StatusSucceeded || got != want {
			t.Errorf("%s: run %s, %s, err %v; want %s", input, res.Status, got, res.Err, want)
		}
	}
}
