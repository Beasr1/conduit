package workflow

import (
	"fmt"
	"maps"
	"slices"
	"strings"
	"testing"
)

// said is outcomes in words, by node id, sorted: "fallback 0 conditional".
func said(d *Definition, out map[int]Outcome) string {
	var words []string
	for x, o := range out {
		w := fmt.Sprintf("%s %v", d.Nodes[x].ID, o.Outputs)
		if o.Conditional {
			w += " conditional"
		}
		words = append(words, w)
	}
	slices.Sort(words)
	return strings.Join(words, ", ")
}

// prefs answers 2xx or 400; on 400, fallback gets them another way.
// prefs_ok takes whichever came, and greet follows it.
const prefsDef = `{"nodes": [
    {"id": "prefs", "kind": "http", "request": {"method": "GET", "url": "https://prefs.example.com/v1"}, "outputs": [{"status": 400}]},
    {"id": "fallback", "kind": "http", "request": {"method": "GET", "url": "https://prefs.example.com/v1/defaults"}},
    {"id": "prefs_ok", "kind": "transform", "expr": "1"},
    {"id": "greet", "kind": "transform", "expr": "2"}],
  "edges": [{"from": "prefs", "to": "prefs_ok"}, {"from": "prefs", "to": "fallback", "on": 400},
    {"from": "fallback", "to": "prefs_ok"}, {"from": "prefs_ok", "to": "greet"}]}`

// What each step before another may have done when a run reaches it: the
// outputs it may answer through, and whether the run may have skipped it.
// prefs answers either way when prefs_ok runs; fallback only comes on 400.
// A step after the merge sees the same. Required, fallback's line makes
// both certain: prefs answered 400.
func TestOutcomes(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, def, node, want string
	}{
		{"a merge", prefsDef, "prefs_ok", "fallback [0] conditional, prefs [0 400]"},
		{"after the merge", prefsDef, "greet", "fallback [0] conditional, prefs [0 400], prefs_ok [0]"},
		{
			"fallback required", strings.Replace(prefsDef, `{"from": "fallback", "to": "prefs_ok"}`, `{"from": "fallback", "to": "prefs_ok", "required": true}`, 1),
			"prefs_ok", "fallback [0], prefs [400]",
		},
		{"the first step", prefsDef, "prefs", ""},
		// A condition may leave x out; in always comes.
		{
			"a condition", `{"nodes": [{"id": "in", "kind": "transform", "expr": "input"},
		    {"id": "x", "kind": "transform", "expr": "1"}, {"id": "t", "kind": "transform", "expr": "2"}],
		  "edges": [{"from": "in", "to": "x", "when": "nodes.in.body.x"}, {"from": "x", "to": "t"}, {"from": "in", "to": "t"}]}`,
			"t", "in [0], x [0] conditional",
		},
		// a and b come whichever way t is reached: each line into them always
		// comes, from a step that answers only one way.
		{
			"always runs", `{"nodes": [{"id": "r", "kind": "http", "request": {"method": "GET", "url": "https://r.example.com/v1"}},
		    {"id": "a", "kind": "http", "request": {"method": "GET", "url": "https://a.example.com/v1"}},
		    {"id": "b", "kind": "transform", "expr": "1"}, {"id": "t", "kind": "transform", "expr": "2"}],
		  "edges": [{"from": "r", "to": "a"}, {"from": "r", "to": "b"}, {"from": "a", "to": "t"}, {"from": "b", "to": "t"}]}`,
			"t", "a [0], b [0], r [0]",
		},
		// count may fail into its Unhandled, which a line leaves, so what
		// follows its value isn't sure to come.
		{
			"an Unhandled", `{"nodes": [{"id": "count", "kind": "transform", "expr": "$number(input.n)"},
		    {"id": "next", "kind": "transform", "expr": "1"}, {"id": "sorry", "kind": "transform", "expr": "2"},
		    {"id": "t", "kind": "transform", "expr": "3"}],
		  "edges": [{"from": "count", "to": "next"}, {"from": "count", "to": "sorry", "unhandled": true},
		    {"from": "next", "to": "t"}, {"from": "sorry", "to": "t"}]}`,
			"t", "count [-1 0], next [0] conditional, sorry [0] conditional",
		},
		// p's line leaves h's 2xx, but h may answer 404, so p may not come,
		// though nothing t's ways need says so.
		{
			"a response that may not come", `{"nodes": [{"id": "h", "kind": "http", "request": {"method": "GET", "url": "https://h.example.com/v1"}, "outputs": [{"status": 404}]},
		    {"id": "p", "kind": "transform", "expr": "1"}, {"id": "z", "kind": "transform", "expr": "2"}, {"id": "t", "kind": "transform", "expr": "3"}],
		  "edges": [{"from": "h", "to": "p"}, {"from": "p", "to": "t"}, {"from": "z", "to": "t"}]}`,
			"t", "h [0 404], p [0] conditional, z [0]",
		},
		// m merges a line that always comes with one that may not, so m always
		// runs; a case's statuses are its outputs, and an answer from its
		// Unhandled one more.
		{
			"a merge that always runs", `{"nodes": [{"id": "in", "kind": "transform", "expr": "input"},
		    {"id": "a", "kind": "transform", "expr": "1"}, {"id": "m", "kind": "transform", "expr": "2"},
		    {"id": "check", "kind": "transform", "switch": {"cases": [{"when": "true", "status": 200}, {"when": "true", "status": 404}]}},
		    {"id": "z", "kind": "transform", "expr": "3"}, {"id": "t", "kind": "transform", "expr": "4"}],
		  "edges": [{"from": "in", "to": "a", "when": "false"}, {"from": "a", "to": "m"}, {"from": "in", "to": "m"},
		    {"from": "m", "to": "t"}, {"from": "check", "to": "t", "on": 200}, {"from": "z", "to": "t"}],
		  "response": {"answers": [{"status": 500, "lines": [{"from": "check", "unhandled": true}]}]}}`,
			"t", "a [0] conditional, check [-1 200 404], in [0], m [0], z [0]",
		},
		// r needs its required line, which may not come, so r may not either.
		{
			"a required line that may not come", `{"nodes": [{"id": "in", "kind": "transform", "expr": "input"},
		    {"id": "c", "kind": "transform", "expr": "1"}, {"id": "r", "kind": "transform", "expr": "2"},
		    {"id": "z", "kind": "transform", "expr": "3"}, {"id": "t", "kind": "transform", "expr": "4"}],
		  "edges": [{"from": "in", "to": "c", "when": "nodes.in.body.c"}, {"from": "c", "to": "r", "required": true},
		    {"from": "r", "to": "t"}, {"from": "z", "to": "t"}]}`,
			"t", "c [0] conditional, in [0], r [0] conditional, z [0]",
		},
		// A case's status names its output.
		{
			"cases", `{"nodes": [{"id": "check", "kind": "transform", "switch": {"cases": [
		      {"when": "true", "status": 200}, {"when": "true", "status": 404}]}},
		    {"id": "t", "kind": "transform", "expr": "1"}],
		  "edges": [{"from": "check", "to": "t", "on": 200}, {"from": "check", "to": "t", "on": 404}]}`,
			"t", "check [200 404]",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			d := decode(t, tt.def)
			i := slices.IndexFunc(d.Nodes, func(n Node) bool { return n.ID == tt.node })
			if got := said(d, Outcomes(d, i)); got != tt.want {
				t.Errorf("Outcomes(%s) = %s, want %s", tt.node, got, tt.want)
			}
		})
	}
}

// A step that never runs, or one on a cycle, has no outcomes to tell.
func TestOutcomes_NoneToTell(t *testing.T) {
	t.Parallel()
	never := decode(t, `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "https://a.example.com/v1"}, "outputs": [{"status": 404}]},
	    {"id": "c", "kind": "transform", "expr": "1"}, {"id": "h", "kind": "http", "request": {"method": "GET", "url": "https://h.example.com/v1"}}],
	  "edges": [{"from": "a", "to": "c", "on": 404}, {"from": "a", "to": "h"}, {"from": "c", "to": "h"}]}`)
	cycle := decode(t, `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}, {"id": "b", "kind": "transform", "expr": "2"}],
	  "edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "a"}]}`)
	for _, tt := range []struct {
		d *Definition
		i int
	}{{never, 2}, {cycle, 1}, {never, -1}, {never, 3}} {
		if out := Outcomes(tt.d, tt.i); out != nil {
			t.Errorf("Outcomes(%d) = %v, want none", tt.i, slices.Collect(maps.Keys(out)))
		}
	}
}
