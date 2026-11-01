package workflow

import (
	"slices"
	"strings"
	"testing"
)

// found is problems as "pointer code", sorted, one per line.
func found(ps Problems) string {
	lines := make([]string, len(ps))
	for i, p := range ps {
		lines[i] = p.Pointer + " " + p.Code
	}
	slices.Sort(lines)
	return strings.Join(lines, "\n")
}

// Fails is every node's Unhandled set to fail the run, so a test of loose
// ends sees only those.
const fails = `"unhandled": {"fail": true}`

func get(id, url string, extra ...string) string {
	parts := append([]string{`"id": "` + id + `"`, `"kind": "http"`, `"request": {"method": "GET", "url": "` + url + `"}`, fails}, extra...)
	return "{" + strings.Join(parts, ", ") + "}"
}

func value(id, expr string, extra ...string) string {
	parts := append([]string{`"id": "` + id + `"`, `"kind": "transform"`, `"expr": "` + expr + `"`, fails}, extra...)
	return "{" + strings.Join(parts, ", ") + "}"
}

// A way a run can go that no answer can follow is a loose end, where the
// road ends: a block with no line onward and no answer joined to it, in no
// run that also answers. A step whose result nobody needs is no loose end
// while its run still answers.
func TestReadyToPublish_LooseEnds(t *testing.T) {
	t.Parallel()
	prefs := get("prefs", "https://prefs.example.com/v1", `"outputs": [{"status": 404}]`)
	tests := []struct {
		name, def, want string
	}{
		{
			"a 404 nothing follows",
			`{"nodes": [` + prefs + `, ` + get("crm", "https://crm.example.com/v1") + `],
			  "edges": [{"from": "prefs", "to": "crm"}],
			  "response": {"answers": [{"status": 200, "lines": [{"from": "crm"}]}]}}`,
			"/nodes/0/outputs/0 no_answer",
		},
		{
			"joined to an answer of its own",
			`{"nodes": [` + prefs + `, ` + get("crm", "https://crm.example.com/v1") + `],
			  "edges": [{"from": "prefs", "to": "crm"}],
			  "response": {"answers": [{"status": 200, "lines": [{"from": "crm"}]}, {"status": 404, "lines": [{"from": "prefs", "on": 404}]}]}}`,
			"",
		},
		{
			// orders answers whichever way prefs went, so prefs' 404, and
			// audit's 2xx, end their roads with the run still answering.
			"another branch still answers",
			`{"nodes": [` + get("user", "https://users.example.com/v1") + `, ` + prefs + `, ` +
				get("orders", "https://orders.example.com/v1") + `, ` + get("audit", "https://audit.example.com/v1") + `],
			  "edges": [{"from": "user", "to": "prefs"}, {"from": "user", "to": "orders"}, {"from": "user", "to": "audit"}],
			  "response": {"answers": [{"status": 200, "lines": [{"from": "orders"}]}]}}`,
			"",
		},
		{
			// fallback runs on prefs' 404, and the answer needs prefs' 2xx.
			// prefs' 404 has a line onward, so only fallback ends the road.
			"a branch that ends after a step",
			`{"nodes": [` + prefs + `, ` + get("fallback", "https://prefs.example.com/v1/defaults") + `, ` + get("crm", "https://crm.example.com/v1") + `],
			  "edges": [{"from": "prefs", "to": "crm"}, {"from": "prefs", "to": "fallback", "on": 404}],
			  "response": {"answers": [{"status": 200, "lines": [{"from": "crm"}]}]}}`,
			"/nodes/1 no_answer",
		},
		{
			// stuck needs both of prefs' outputs, so it never runs, a problem
			// of its own: its answer answers no run, so crm ends its road
			// unanswered.
			"an answer from a step that never runs",
			`{"nodes": [` + prefs + `, ` + get("stuck", "https://stuck.example.com/v1") + `, ` + get("crm", "https://crm.example.com/v1") + `],
			  "edges": [{"from": "prefs", "to": "stuck"}, {"from": "prefs", "to": "stuck", "on": 404}, {"from": "prefs", "to": "crm"}],
			  "response": {"answers": [{"status": 200, "lines": [{"from": "stuck"}]}]}}`,
			"/nodes/2 no_answer",
		},
		{
			"a transform's value",
			`{"nodes": [` + prefs + `, ` + value("note", "'no prefs'") + `, ` + get("crm", "https://crm.example.com/v1") + `],
			  "edges": [{"from": "prefs", "to": "crm"}, {"from": "prefs", "to": "note", "on": 404}],
			  "response": {"answers": [{"status": 200, "lines": [{"from": "crm"}]}]}}`,
			"/nodes/1/expr no_answer",
		},
		{
			"a case",
			`{"nodes": [{"id": "check", "kind": "transform", ` + fails + `, "switch": {"cases": [
			    {"when": "input.ok", "status": 200, "body": "1"}, {"when": "true", "status": 404, "body": "2"}]}}],
			  "response": {"answers": [{"status": 200, "lines": [{"from": "check", "on": 200}]}]}}`,
			"/nodes/0/switch/cases/1 no_answer",
		},
		{
			// prefs' Unhandled goes on to sorry, which answers nothing; the
			// answer needs prefs' 2xx.
			"after an Unhandled",
			`{"nodes": [{"id": "prefs", "kind": "http", "request": {"method": "GET", "url": "https://prefs.example.com/v1"}}, ` +
				value("sorry", "'down'") + `, ` + get("crm", "https://crm.example.com/v1") + `],
			  "edges": [{"from": "prefs", "to": "crm"}, {"from": "prefs", "to": "sorry", "unhandled": true}],
			  "response": {"answers": [{"status": 200, "lines": [{"from": "crm"}]}]}}`,
			"/nodes/1/expr no_answer",
		},
		{
			// A merge runs on whichever came, so both roads into it answer.
			"a merge",
			`{"nodes": [` + prefs + `, ` + get("fallback", "https://prefs.example.com/v1/defaults") + `, ` + value("pick", "1") + `],
			  "edges": [{"from": "prefs", "to": "pick"}, {"from": "prefs", "to": "fallback", "on": 404}, {"from": "fallback", "to": "pick"}],
			  "response": {"answers": [{"status": 200, "lines": [{"from": "pick"}]}]}}`,
			"",
		},
		{
			// A condition is data, so a road it may cut still counts as
			// answering: the response's error body answers such a run.
			"a condition",
			`{"nodes": [` + value("start", "input") + `, ` + value("a", "1") + `],
			  "edges": [{"from": "start", "to": "a", "when": "input.go"}],
			  "response": {"answers": [{"status": 200, "lines": [{"from": "a"}]}]}}`,
			"",
		},
		{
			// One exit (plan 14): every node's failures into the 500, listed
			// first, and each result into an answer below it.
			"failures into one answer, above the rest",
			`{"nodes": [{"id": "prefs", "kind": "http", "request": {"method": "GET", "url": "https://prefs.example.com/v1"}, "outputs": [{"status": 404}]},
			    {"id": "note", "kind": "transform", "expr": "'no prefs'"}],
			  "edges": [{"from": "prefs", "to": "note", "on": 404}],
			  "response": {"answers": [{"status": 500, "lines": [{"from": "prefs", "unhandled": true}, {"from": "note", "unhandled": true}]},
			    {"status": 200, "lines": [{"from": "prefs"}]}, {"status": 404, "lines": [{"from": "note"}]}]}}`,
			"",
		},
		{
			"no response",
			`{"nodes": [` + value("a", "1") + `]}`,
			"/response/answers no_answers",
		},
		{
			// Revisions saved with an output answer it, 200, every run.
			"an output",
			`{"nodes": [` + value("a", "1") + `], "output": "nodes.a.body"}`,
			"",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			d := decode(t, tt.def)
			if ps := Validate(d); len(ps) > 0 && tt.want == "" {
				t.Fatalf("Validate() = %v, want none, so only ReadyToPublish speaks", ps)
			}
			if got := found(ReadyToPublish(d)); got != tt.want {
				t.Errorf("ReadyToPublish() =\n%s\nwant\n%s", got, tt.want)
			}
		})
	}
}

// Every node's failures go where someone chose: a line or an answer from its
// Unhandled block, or the run failing, on purpose. Undecided, or both, is a
// problem. A node that never runs has its own.
func TestReadyToPublish_Failures(t *testing.T) {
	t.Parallel()
	answer := `"response": {"answers": [{"status": 200, "lines": [{"from": "a"}]}]}`
	tests := []struct {
		name, def, want string
	}{
		{"failing on purpose", `{"nodes": [{"id": "a", "kind": "transform", "expr": "1", "unhandled": {"fail": true}}], ` + answer + `}`, ""},
		{"undecided", `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}], ` + answer + `}`, "/nodes/0/unhandled unhandled_undecided"},
		{
			"a body but no decision",
			`{"nodes": [{"id": "a", "kind": "transform", "expr": "1", "unhandled": {"body": "2"}}], ` + answer + `}`,
			"/nodes/0/unhandled unhandled_undecided",
		},
		{
			"joined by a line",
			`{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}, ` + value("b", "2") + `],
			  "edges": [{"from": "a", "to": "b", "unhandled": true}],
			  "response": {"answers": [{"status": 200, "lines": [{"from": "a"}]}, {"status": 500, "lines": [{"from": "b"}]}]}}`,
			"",
		},
		{
			"joined to an answer",
			`{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}],
			  "response": {"answers": [{"status": 200, "lines": [{"from": "a"}]}, {"status": 500, "lines": [{"from": "a", "unhandled": true}]}]}}`,
			"",
		},
		{
			"joined and failing",
			`{"nodes": [{"id": "a", "kind": "transform", "expr": "1", "unhandled": {"fail": true}}],
			  "response": {"answers": [{"status": 200, "lines": [{"from": "a"}]}, {"status": 500, "lines": [{"from": "a", "unhandled": true}]}]}}`,
			"/nodes/0/unhandled/fail unhandled_both",
		},
		{
			// c needs a to answer 404 and 2xx at once, so it never runs, and
			// says so itself.
			"a node that never runs",
			`{"nodes": [` + get("a", "https://a.example.com/v1", `"outputs": [{"status": 404}]`) + `,
			    ` + value("b", "1") + `, {"id": "c", "kind": "http", "request": {"method": "GET", "url": "https://c.example.com/v1"}}],
			  "edges": [{"from": "a", "to": "b", "on": 404}, {"from": "a", "to": "c"}, {"from": "b", "to": "c"}],
			  "response": {"answers": [{"status": 200, "lines": [{"from": "a"}]}, {"status": 404, "lines": [{"from": "b"}]}]}}`,
			"",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := found(ReadyToPublish(decode(t, tt.def))); got != tt.want {
				t.Errorf("ReadyToPublish() =\n%s\nwant\n%s", got, tt.want)
			}
		})
	}
}

// A cycle is Validate's problem; there's nothing to route.
func TestReadyToPublish_Cycle(t *testing.T) {
	t.Parallel()
	d := decode(t, `{"nodes": [`+value("a", "1")+`, `+value("b", "2")+`],
	  "edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "a"}],
	  "response": {"answers": [{"status": 200, "lines": [{"from": "a"}]}]}}`)
	if got := found(ReadyToPublish(d)); got != "" {
		t.Errorf("ReadyToPublish() = %s, want none", got)
	}
}
