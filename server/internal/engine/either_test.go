package engine

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Beasr1/conduit/server/internal/workflow"
)

// An either gives what the way that came gives: its edge's body, or the
// body of the node it came from, as it is. prefs answers 2xx or 400; on
// 400, fallback gets them another way.
func TestRun_EitherGivesTheWayThatCame(t *testing.T) {
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
	    {"id": "prefs_ok", "kind": "either"},
	    {"id": "greet", "kind": "transform", "expr": "'theme: ' & nodes.prefs_ok.body.theme"}
	  ],
	  "edges": [
	    {"from": "prefs", "to": "prefs_ok"},
	    {"from": "prefs", "to": "fallback", "on": 400},
	    {"from": "fallback", "to": "prefs_ok", "body": "nodes.fallback.body.data"},
	    {"from": "prefs_ok", "to": "greet"}
	  ],
	  "response": {"answers": [{"status": 200, "from": "greet"}, {"status": 201, "from": "prefs_ok", "unhandled": true}]}
	}`)
	tests := []struct {
		id, nodes, output string
		way               Way
	}{
		{"7", "prefs succeeded, fallback skipped, prefs_ok succeeded, greet succeeded", `"theme: dark"`, Way{From: "prefs"}},
		{"new", "prefs succeeded, fallback succeeded, prefs_ok succeeded, greet succeeded", `"theme: light"`, Way{From: "fallback"}},
	}
	for _, tt := range tests {
		t.Run(tt.id, func(t *testing.T) {
			t.Parallel()
			res, rec := execute(t, testEngine(Options{}), p, `{"id": "`+tt.id+`"}`)
			if res.Status != StatusSucceeded || statuses(res) != tt.nodes || res.Answer != http.StatusOK || string(res.Output) != tt.output {
				t.Errorf("run %s (%s), answer %d %s, err %v; want succeeded (%s), 200 %s",
					res.Status, statuses(res), res.Answer, res.Output, res.Err, tt.nodes, tt.output)
			}
			if w := res.Nodes[2].Way; w == nil || *w != tt.way {
				t.Errorf("prefs_ok's way = %v, want %v", w, tt.way)
			}
			// The event that ends it carries the way too.
			for _, e := range rec.events {
				if e.Node == "prefs_ok" && e.Kind == EventSucceeded && (e.Result.Way == nil || *e.Result.Way != tt.way) {
					t.Errorf("prefs_ok's last event carries the way %v, want %v", e.Result.Way, tt.way)
				}
			}
		})
	}
}

// An either none of whose ways is taken is skipped, and so are the nodes
// after it.
func TestRun_EitherWithNoWaySkips(t *testing.T) {
	t.Parallel()
	p := program(t, "", `{
	  "nodes": [
	    {"id": "a", "kind": "transform", "expr": "input.n"},
	    {"id": "e", "kind": "either"},
	    {"id": "after", "kind": "transform", "expr": "nodes.e.body"}
	  ],
	  "edges": [{"from": "a", "to": "e", "when": "nodes.a.body = 1"}, {"from": "e", "to": "after"}]
	}`)
	res, rec := execute(t, testEngine(Options{}), p, `{"n": 2}`)
	if res.Status != StatusSucceeded || statuses(res) != "a succeeded, e skipped, after skipped" || rec.list(EventSkipped) != "e skipped, after skipped" {
		t.Errorf("run %s (%s), skips %s", res.Status, statuses(res), rec.list(EventSkipped))
	}
	if res, _ := execute(t, testEngine(Options{}), p, `{"n": 1}`); statuses(res) != "a succeeded, e succeeded, after succeeded" || string(res.Nodes[2].Body) != "1" {
		t.Errorf("n 1: %s, after gave %s", statuses(res), res.Nodes[2].Body)
	}
}

// A way's body reads what its edge's condition does: the nodes before the
// one it came from, and that one. z runs either way, but only q's way comes
// after it; the nodes after the either read every node before them.
func TestRun_EitherReadsWhatItsWayRead(t *testing.T) {
	t.Parallel()
	p := program(t, "", `{
	  "nodes": [
	    {"id": "r", "kind": "transform", "expr": "input.x"},
	    {"id": "z", "kind": "transform", "expr": "'z'"},
	    {"id": "p", "kind": "transform", "expr": "'p'"},
	    {"id": "q", "kind": "transform", "expr": "'q'"},
	    {"id": "e", "kind": "either"},
	    {"id": "after", "kind": "transform", "expr": "{ 'e': nodes.e.body, 'z': nodes.z.body }"}
	  ],
	  "edges": [
	    {"from": "r", "to": "p", "when": "nodes.r.body = 1"},
	    {"from": "r", "to": "q", "when": "nodes.r.body = 2"},
	    {"from": "z", "to": "q"},
	    {"from": "p", "to": "e", "body": "{ 'p': nodes.p.body, 'r': nodes.r.body, 'z': $exists(nodes.z) }"},
	    {"from": "q", "to": "e", "body": "{ 'q': nodes.q.body, 'r': nodes.r.body, 'z': nodes.z.body }"},
	    {"from": "e", "to": "after"}
	  ],
	  "output": "nodes.after.body"
	}`)
	for x, want := range map[string]string{
		"1": `{"e":{"p":"p","r":1,"z":false},"z":"z"}`,
		"2": `{"e":{"q":"q","r":2,"z":"z"},"z":"z"}`,
	} {
		if res, _ := execute(t, testEngine(Options{}), p, `{"x": `+x+`}`); string(res.Output) != want {
			t.Errorf("x %s: output %s (%v), want %s", x, res.Output, res.Err, want)
		}
	}
}

// Two ways coming in one run fail the either, which only conditions can
// cause in a definition with no problems; its Unhandled block takes that,
// as it takes a way's body failing.
func TestRun_EitherFails(t *testing.T) {
	t.Parallel()
	def := `{
	  "nodes": [
	    {"id": "a", "kind": "transform", "expr": "input.n"},
	    {"id": "b", "kind": "transform", "expr": "'b'"},
	    {"id": "c", "kind": "transform", "expr": "'c'"},
	    {"id": "e", "kind": "either"},
	    {"id": "caught", "kind": "transform", "expr": "nodes.e.error"}
	  ],
	  "edges": [
	    {"from": "a", "to": "b", "when": "nodes.a.body >= 1"},
	    {"from": "a", "to": "c", "when": "nodes.a.body <= 1"},
	    {"from": "b", "to": "e", "body": "$number(nodes.b.body)"},
	    {"from": "c", "to": "e"}
	    CATCH
	  ],
	  "output": "{ 'e': nodes.e.body, 'caught': nodes.caught.body }"
	}`
	caught := program(t, "", strings.Replace(def, "CATCH", `, {"from": "e", "to": "caught", "unhandled": true}`, 1))
	// What the output starts with.
	for n, want := range map[string]string{
		"0": `{"e":"c"}`,
		"1": `{"caught":{"code":"workflow_error","detail":"two ways came: from b and from c"}}`,
		"2": `{"caught":{"code":"workflow_error","detail":"the way from b: body: `,
	} {
		res, _ := execute(t, testEngine(Options{}), caught, `{"n": `+n+`}`)
		if res.Status != StatusSucceeded || !strings.HasPrefix(string(res.Output), want) {
			t.Errorf("n %s: run %s (%s), output %s, err %v; want %s…", n, res.Status, statuses(res), res.Output, res.Err, want)
		}
		if failed := res.Nodes[3].Status == StatusFailed; failed != (n != "0") || (n == "1") != (res.Nodes[3].Way == nil) {
			t.Errorf("n %s: e %s, way %v", n, res.Nodes[3].Status, res.Nodes[3].Way)
		}
	}
	res, _ := execute(t, testEngine(Options{}), program(t, "", strings.Replace(def, "CATCH", `, {"from": "e", "to": "caught"}`, 1)), `{"n": 1}`)
	if res.Status != StatusFailed || res.Err == nil || res.Err.Error() != "node e: two ways came: from b and from c" {
		t.Errorf("uncaught: run %s, err %v", res.Status, res.Err)
	}
}

// With no body, a way gives the body of the node it came from as the nodes
// after read it, its Unhandled body's or what it got, and null when there's
// none, as a transform that failed has.
func TestRun_EitherPassesTheBodyOn(t *testing.T) {
	t.Parallel()
	p := program(t, "", `{
	  "nodes": [
	    {"id": "count", "kind": "transform", "expr": "$number(input.n)"},
	    {"id": "e", "kind": "either"}
	  ],
	  "edges": [{"from": "count", "to": "e"}, {"from": "count", "to": "e", "unhandled": true}],
	  "output": "{ 'got': nodes.e.body }"
	}`)
	for n, want := range map[string]struct {
		output string
		way    Way
	}{
		`"2"`: {`{"got":2}`, Way{From: "count"}},
		`"x"`: {`{"got":null}`, Way{From: "count", On: workflow.OnUnhandled}},
	} {
		res, _ := execute(t, testEngine(Options{}), p, `{"n": `+n+`}`)
		if string(res.Output) != want.output || res.Nodes[1].Way == nil || *res.Nodes[1].Way != want.way {
			t.Errorf("n %s: output %s (%v), way %v; want %s, %v", n, res.Output, res.Err, res.Nodes[1].Way, want.output, want.way)
		}
	}
}

// eithered is prefs, falling back on fallback on 400, the two joined in
// prefs_ok, with a sample for each response.
const eithered = `{
  "nodes": [
    {"id": "prefs", "kind": "http", "request": {"method": "GET", "url": "https://prefs.example.com/v1/7"},
     "sample": {"body": {"theme": "dark"}}, "outputs": [{"status": 400, "sample": {"body": {"error": "no prefs yet"}}}]},
    {"id": "fallback", "kind": "http", "request": {"method": "GET", "url": "https://prefs.example.com/v1/defaults"},
     "sample": {"body": {"data": {"theme": "light"}}}},
    {"id": "prefs_ok", "kind": "either"},
    {"id": "greet", "kind": "transform", "expr": "'theme: ' & nodes.prefs_ok.body.theme"}
  ],
  "edges": [
    {"from": "prefs", "to": "prefs_ok"},
    {"from": "prefs", "to": "fallback", "on": 400},
    {"from": "fallback", "to": "prefs_ok", "body": "nodes.fallback.body.data"},
    {"from": "prefs_ok", "to": "greet"}
  ]
}`

// Previewing an either, or a step after one, takes the way previews take,
// 2xx first: the either reads what that way read, and gives what it gives.
func TestSimulate_TakesAnEithersWay(t *testing.T) {
	t.Parallel()
	pv := previewOf(t, eithered, "prefs_ok", nil)
	if pv.Skipped || problemCodes(pv) != "" || !sameJSON(t, pv.Gives, `{"theme": "dark"}`) ||
		!sameJSON(t, pv.Reads, `{"input": null, "nodes": {"prefs": {"status": 200, "headers": {}, "body": {"theme": "dark"}}}}`) {
		t.Errorf("prefs_ok: skipped %v, gives %s, reads %s, problems %s", pv.Skipped, pv.Gives, pv.Reads, problemCodes(pv))
	}
	if pv := previewOf(t, eithered, "greet", nil); !sameJSON(t, pv.Gives, `"theme: dark"`) || problemCodes(pv) != "" {
		t.Errorf("greet gives %s, problems %s", pv.Gives, problemCodes(pv))
	}
	// The way taken, wherever it is among the edges.
	pv = previewOf(t, eithered, "prefs_ok", func(d *workflow.Definition) { d.Edges[0], d.Edges[2] = d.Edges[2], d.Edges[0] })
	if !sameJSON(t, pv.Gives, `{"theme": "dark"}`) || problemCodes(pv) != "" {
		t.Errorf("prefs' way second: gives %s, problems %s", pv.Gives, problemCodes(pv))
	}
	pv = previewOf(t, eithered, "greet", func(d *workflow.Definition) { d.Edges[0].When = "false" })
	if !pv.Skipped {
		t.Errorf("no way taken: greet skipped %v, gives %s", pv.Skipped, pv.Gives)
	}
}

// A line into an either previews what the either gives when it's the one
// taken, over what the line's condition reads, its source answering
// through it; and says what's wrong with its body.
func TestSimulateEdge_GivesWhatTheEitherGives(t *testing.T) {
	t.Parallel()
	pv := edgePreviewOf(t, eithered, 2, nil)
	if taken(pv) != "true" || problemCodes(pv) != "" || !sameJSON(t, pv.Gives, `{"theme": "light"}`) ||
		!sameJSON(t, pv.Reads, `{"input": null, "nodes": {"prefs": {"status": 400, "headers": {}, "body": {"error": "no prefs yet"}},
			"fallback": {"status": 200, "headers": {}, "body": {"data": {"theme": "light"}}}}}`) {
		t.Errorf("fallback's: taken %s, gives %s, reads %s, problems %s", taken(pv), pv.Gives, pv.Reads, problemCodes(pv))
	}
	if pv := edgePreviewOf(t, eithered, 0, nil); !sameJSON(t, pv.Gives, `{"theme": "dark"}`) {
		t.Errorf("prefs' gives %s", pv.Gives)
	}
	for body, want := range map[string]string{"$number('x')": "/edges/2/body evaluation_failed", "$sum(": "/edges/2/body invalid_expression"} {
		pv := edgePreviewOf(t, eithered, 2, func(d *workflow.Definition) { d.Edges[2].Body = body })
		if pv.Gives != nil || problemCodes(pv) != want {
			t.Errorf("%s: gives %s, problems %s; want %s", body, pv.Gives, problemCodes(pv), want)
		}
	}
	if pv := edgePreviewOf(t, eithered, 1, nil); pv.Gives != nil {
		t.Errorf("a line into a step that isn't an either gives %s", pv.Gives)
	}
}
