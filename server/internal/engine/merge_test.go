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

// A merge runs once every edge into it has ended, if any was taken, and
// gives what its expr makes of whatever came. prefs answers 2xx or 400; on
// 400, fallback gets them another way.
func TestRun_MergeGivesWhatItsExprMakes(t *testing.T) {
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
	    {"id": "prefs_ok", "kind": "merge", "expr": "$exists(nodes.fallback) ? nodes.fallback.body.data : nodes.prefs.body"},
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
// the merge is skipped, and so are the steps after it.
func TestRun_MergeTakesWhateverCame(t *testing.T) {
	t.Parallel()
	p := program(t, "", `{
	  "nodes": [
	    {"id": "in", "kind": "transform", "expr": "input"},
	    {"id": "a", "kind": "transform", "expr": "'a'"},
	    {"id": "b", "kind": "transform", "expr": "'b'"},
	    {"id": "e", "kind": "merge", "expr": "{ 'a': nodes.a.body, 'b': nodes.b.body }"},
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
	}
}

// A merge's expr failing fails it, and its Unhandled block takes that, as it
// takes any node's failure; the ways that came are recorded all the same.
func TestRun_MergeExprThatFails(t *testing.T) {
	t.Parallel()
	p := program(t, "", `{
	  "nodes": [
	    {"id": "a", "kind": "transform", "expr": "'x'"},
	    {"id": "e", "kind": "merge", "expr": "$number(nodes.a.body)"},
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

// A merge joined to a step's Unhandled records the way it came by as that.
func TestRun_MergeRecordsAnUnhandledWay(t *testing.T) {
	t.Parallel()
	p := program(t, "", `{
	  "nodes": [
	    {"id": "count", "kind": "transform", "expr": "$number(input.n)"},
	    {"id": "e", "kind": "merge", "expr": "$exists(nodes.count.error) ? 0 : nodes.count.body"}
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
    {"id": "prefs_ok", "kind": "merge", "expr": "$exists(nodes.fallback) ? nodes.fallback.body.data : nodes.prefs.body"},
    {"id": "greet", "kind": "transform", "expr": "'theme: ' & nodes.prefs_ok.body.theme"}
  ],
  "edges": [
    {"from": "prefs", "to": "prefs_ok"},
    {"from": "prefs", "to": "fallback", "on": 400},
    {"from": "fallback", "to": "prefs_ok"},
    {"from": "prefs_ok", "to": "greet"}
  ]
}`

// A merge previews as a transform does, over the way previews take, 2xx
// first; with no way taken, it's skipped, and so are the steps after it.
func TestSimulate_AMerge(t *testing.T) {
	t.Parallel()
	pv := previewOf(t, merged, "prefs_ok", nil)
	if pv.Skipped || problemCodes(pv) != "" || !sameJSON(t, pv.Gives, `{"theme": "dark"}`) ||
		!sameJSON(t, pv.Reads, `{"input": null, "nodes": {"prefs": {"status": 200, "headers": {}, "body": {"theme": "dark"}}}}`) {
		t.Errorf("prefs_ok: skipped %v, gives %s, reads %s, problems %s", pv.Skipped, pv.Gives, pv.Reads, problemCodes(pv))
	}
	if pv := previewOf(t, merged, "greet", nil); !sameJSON(t, pv.Gives, `"theme: dark"`) || problemCodes(pv) != "" {
		t.Errorf("greet gives %s, problems %s", pv.Gives, problemCodes(pv))
	}
	pv = previewOf(t, merged, "greet", func(d *workflow.Definition) { d.Edges[0].When = "false" })
	if !pv.Skipped {
		t.Errorf("no way taken: greet skipped %v, gives %s", pv.Skipped, pv.Gives)
	}
}
