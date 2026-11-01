package workflow

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

// specExample is the roadmap's example: user, then orders and prefs in
// parallel, then crm.
const specExample = `{
  "nodes": [
    {"id": "user", "kind": "http",
     "request": {"method": "GET", "url": "https://users.example.com/v1/users/{{ input.user_id }}"}},
    {"id": "orders", "kind": "http",
     "request": {"method": "GET", "url": "https://orders.example.com/v1/orders?user={{ nodes.user.body.id }}"}},
    {"id": "prefs", "kind": "http",
     "request": {"method": "GET", "url": "https://prefs.example.com/v1/{{ nodes.user.body.id }}"}},
    {"id": "crm", "kind": "http",
     "request": {"method": "POST", "url": "https://crm.example.com/v1/contacts",
                 "body": "{ 'email': nodes.user.body.email }"}}
  ],
  "edges": [
    {"from": "user", "to": "orders"},
    {"from": "user", "to": "prefs"},
    {"from": "orders", "to": "crm"},
    {"from": "prefs", "to": "crm"}
  ],
  "output": "{ 'crm_id': nodes.crm.body.id }"
}`

func decode(t *testing.T, s string) *Definition {
	t.Helper()
	var d Definition
	if err := json.Unmarshal([]byte(s), &d); err != nil {
		t.Fatalf("decode definition: %v", err)
	}
	return &d
}

func TestValidate_AcceptsSpecExample(t *testing.T) {
	t.Parallel()
	if ps := Validate(decode(t, specExample)); len(ps) > 0 {
		t.Fatalf("Validate() = %v, want no problems", ps)
	}
}

// A sample stands in for a response that can be anything, an empty one
// included, so a null body and a status-less sample are fine.
func TestValidate_AcceptsSamples(t *testing.T) {
	t.Parallel()
	d := decode(t, `{"nodes": [
		{"id": "a", "kind": "http", "request": {"method": "GET", "url": "https://api.example.com/v1"},
		 "sample": {"body": null}},
		{"id": "b", "kind": "http", "request": {"method": "GET", "url": "https://api.example.com/v1"},
		 "sample": {"status": 201, "headers": {"Content-Type": "application/json"}, "body": {"id": "7"}}}],
		"sample_input": [1, 2, 3]}`)
	if ps := Validate(d); len(ps) > 0 {
		t.Fatalf("Validate() = %v, want no problems", ps)
	}
}

// A step can answer through outputs besides 2xx, each with a sample or
// none, and two steps can be joined once per output: here log, a
// transform, follows user whichever way it answered.
func TestValidate_AcceptsOutputs(t *testing.T) {
	t.Parallel()
	d := decode(t, `{"nodes": [
		{"id": "user", "kind": "http", "request": {"method": "GET", "url": "https://api.example.com/v1"},
		 "outputs": [{"status": 404, "sample": {"headers": {"Content-Type": "application/json"}, "body": {"error": "gone"}}},
		             {"status": 409}]},
		{"id": "create", "kind": "transform", "expr": "1"},
		{"id": "log", "kind": "transform", "expr": "nodes.user.status"}],
		"edges": [{"from": "user", "to": "create", "on": 404},
		          {"from": "user", "to": "log"},
		          {"from": "user", "to": "log", "on": 404}]}`)
	if ps := Validate(d); len(ps) > 0 {
		t.Fatalf("Validate() = %v, want no problems", ps)
	}
}

// A workflow answers through its response: each answer a status, joined by
// one line from the node that gives it.
func TestValidate_AcceptsResponses(t *testing.T) {
	t.Parallel()
	// user answers 2xx or 404, on to found or gone.
	branched := `{"id": "user", "kind": "http", "request": {"method": "GET", "url": "https://api.example.com/v1"}, "outputs": [{"status": 404}]},
		{"id": "found", "kind": "transform", "expr": "1"}, {"id": "gone", "kind": "transform", "expr": "2"}`
	branches := `[{"from": "user", "to": "found"}, {"from": "user", "to": "gone", "on": 404}]`
	for name, def := range map[string]string{
		"one answer": `{"nodes": [{"id": "respond", "kind": "transform", "expr": "1"}],
			"response": {"answers": [{"status": 200, "from": "respond", "schema": {"type": "object"}}]}}`,
		"one node picking among several": `{"nodes": [{"id": "respond", "kind": "transform", "expr": "1"}],
			"response": {"answers": [{"status": 200, "from": "respond"}, {"status": 400, "from": "respond"}]}}`,
		"each output of an http node to its own": `{"nodes": [` + branched + `],
			"response": {"answers": [{"status": 200, "from": "user"}, {"status": 404, "from": "user", "on": 404}]}}`,
		"branches one node keeps apart": `{"nodes": [` + branched + `], "edges": ` + branches + `,
			"response": {"answers": [{"status": 200, "from": "found"}, {"status": 404, "from": "gone"}]}}`,
		"a switch's cases, each to the answer of its status": `{"nodes": [{"id": "respond", "kind": "transform",
			"switch": {"cases": [{"name": "gone", "when": "input.id = 0", "status": 404, "body": "{ 'error': 'gone' }"}, {"when": "true", "status": 200}]}}],
			"response": {"answers": [{"status": 200, "from": "respond", "on": 200}, {"status": 404, "from": "respond", "on": 404}]}}`,
		"unhandled": `{"nodes": [{"id": "respond", "kind": "transform", "expr": "1"}],
			"response": {"answers": [{"status": 200, "from": "respond"}], "unhandled": {"body": "{ 'error': error.detail }"}}}`,
		"a node's Unhandled to an answer of its own": `{"nodes": [` + branched + `],
			"response": {"answers": [{"status": 200, "from": "user"}, {"status": 404, "from": "user", "on": 404}, {"status": 502, "from": "user", "unhandled": true}]}}`,
		"a switch's Unhandled beside its cases": `{"nodes": [{"id": "respond", "kind": "transform",
			"switch": {"cases": [{"when": "input.id = 0", "status": 404}, {"when": "true", "status": 200}]}}],
			"response": {"answers": [{"status": 200, "from": "respond", "on": 200}, {"status": 404, "from": "respond", "on": 404}, {"status": 500, "from": "respond", "unhandled": true}]}}`,
		"an edge from Unhandled, and one from 2xx, into a transform": `{"nodes": [` + branched + `, {"id": "either_way", "kind": "transform", "expr": "nodes.user"}],
			"edges": [{"from": "user", "to": "either_way"}, {"from": "user", "to": "either_way", "unhandled": true}, {"from": "either_way", "to": "found"}, {"from": "found", "to": "gone", "unhandled": true}],
			"response": {"answers": [{"status": 200, "from": "gone"}]}}`,
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if ps := Validate(decode(t, def)); len(ps) > 0 {
				t.Fatalf("Validate() = %v, want no problems", ps)
			}
		})
	}
}

// A transform's cases are its exits, each named by its status: a line
// leaves one for a step, a transform or the answer of its status, and the
// cases' exits keep their lines apart as an http node's outputs do.
func TestValidate_CasesAreExits(t *testing.T) {
	t.Parallel()
	get := `"request": {"method": "GET", "url": "https://api.example.com/v1"}`
	check := `{"id": "check", "kind": "transform", "switch": {
		"cases": [{"name": "found", "when": "input.id > 0", "status": 200}, {"name": "missing", "when": "input.id = 0", "status": 404},
		          {"name": "else", "when": "true", "status": 500}]}}`
	ps := Validate(decode(t, `{"nodes": [`+check+`, {"id": "greet", "kind": "transform", "expr": "1"}, {"id": "fallback", "kind": "http", `+get+`}],
	  "edges": [{"from": "check", "to": "greet", "on": 200}, {"from": "check", "to": "fallback", "on": 404}],
	  "response": {"answers": [{"status": 200, "from": "greet"}, {"status": 404, "from": "fallback"}, {"status": 500, "from": "check", "on": 500}]}}`))
	if len(ps) > 0 {
		t.Errorf("Validate() = %v, want no problems", ps)
	}
	// An http node joined to two of them needs both, so it never runs.
	ps = Validate(decode(t, `{"nodes": [`+check+`, {"id": "notify", "kind": "http", `+get+`}],
	  "edges": [{"from": "check", "to": "notify", "on": 200}, {"from": "check", "to": "notify", "on": 404}]}`))
	if len(ps) != 1 || ps[0].Pointer != "/nodes/1" || ps[0].Detail != "notify can never run: it needs check to answer 200 and 404" {
		t.Errorf("an http node needing two cases: problems %v", ps)
	}
}

// Whether two answers' lines can be taken in one run is read from the
// graph: an http node runs once each node with a line into it took one of
// them, so only one node's outputs that share none keep two lines apart.
// crm runs after orders and prefs; prefs' 400 leads to test_400.
func TestValidate_TwoAnswersInOneRun(t *testing.T) {
	t.Parallel()
	get := `"request": {"method": "GET", "url": "https://api.example.com/v1"}`
	nodes := `[{"id": "people", "kind": "http", ` + get + `}, {"id": "orders", "kind": "http", ` + get + `},
		{"id": "prefs", "kind": "http", ` + get + `, "outputs": [{"status": 400}]}, {"id": "crm", "kind": "http", ` + get + `, "outputs": [{"status": 400}]},
		{"id": "test_400", "kind": "http", ` + get + `}, {"id": "notify", "kind": "http", ` + get + `}, {"id": "bad_400", "kind": "transform", "expr": "2"}]`
	edges := `{"from": "people", "to": "orders"}, {"from": "people", "to": "prefs"}, {"from": "orders", "to": "crm"}, {"from": "prefs", "to": "crm"},
		{"from": "crm", "to": "notify"}, {"from": "crm", "to": "bad_400", "on": 400}`
	response := `{"answers": [{"status": 200, "from": "notify"}, {"status": 400, "from": "bad_400"}]}`
	tests := []struct {
		name, edges, want string
	}{
		// crm's 2xx and 400 keep notify and bad_400 apart.
		{"kept apart by crm", edges, ""},
		// notify needs crm, which needs prefs' 2xx, and test_400, which needs
		// its 400: it never runs, and its answer is no overlap.
		{
			"never reached when notify needs both of prefs' outputs", edges + `, {"from": "prefs", "to": "test_400", "on": 400}, {"from": "test_400", "to": "notify"}`,
			"/nodes/5 never_runs: notify can never run: it needs prefs to answer 2xx and 400",
		},
		// crm's Unhandled is one more output, kept apart from its 2xx and 400.
		{"kept apart by crm's Unhandled", edges + `, {"from": "crm", "to": "test_400", "unhandled": true}`, ""},
		{
			"never reached when notify needs crm's 2xx and its Unhandled", edges + `, {"from": "crm", "to": "test_400", "unhandled": true}, {"from": "test_400", "to": "notify"}`,
			"/nodes/5 never_runs: notify can never run: it needs crm to answer 2xx and Unhandled",
		},
		// notify needs every line into it, and crm answers one way.
		{
			"never reached when notify needs two of crm's outputs", edges + `, {"from": "crm", "to": "notify", "on": 400}`,
			"/nodes/5 never_runs: notify can never run: it needs crm to answer 2xx and 400",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			ps := Validate(decode(t, `{"nodes": `+nodes+`, "edges": [`+tt.edges+`], "response": `+response+`}`))
			var got []string
			for _, p := range ps {
				got = append(got, p.Pointer+" "+p.Code+": "+p.Detail)
			}
			if strings.Join(got, "\n") != tt.want {
				t.Errorf("problems:\n%s\nwant:\n%s", strings.Join(got, "\n"), tt.want)
			}
		})
	}
}

// A transform runs if any edge into it was taken, its expr reading
// whatever came, so the nodes after it can follow either arm of a branch,
// or whichever of several nodes answered. Its route merges its ways',
// counting a node a way rules out as not running, so the checks stay exact
// where ways part at one node's outputs, chains of them included.
func TestValidate_ATransformMerges(t *testing.T) {
	t.Parallel()
	get := `"request": {"method": "GET", "url": "https://api.example.com/v1"}`
	for name, def := range map[string]string{
		// prefs answers 2xx or 400; on 400, test_400 gets them another way, and
		// failing, answers 502 itself.
		"the arms of a branch": `{"nodes": [
			{"id": "prefs", "kind": "http", ` + get + `, "outputs": [{"status": 400}]}, {"id": "test_400", "kind": "http", ` + get + `},
			{"id": "prefs_ok", "kind": "transform", "expr": "$exists(nodes.test_400) ? nodes.test_400.body.data : nodes.prefs.body"},
			{"id": "success_200", "kind": "transform", "expr": "nodes.prefs_ok.body"}],
		  "edges": [{"from": "prefs", "to": "prefs_ok"}, {"from": "prefs", "to": "test_400", "on": 400},
		            {"from": "test_400", "to": "prefs_ok"}, {"from": "prefs_ok", "to": "success_200"}],
		  "response": {"answers": [{"status": 200, "from": "success_200"}, {"status": 502, "from": "test_400", "unhandled": true}]}}`,
		// s1 and s2 each fall back on f1 and f2 on 404, and a fallback that
		// fails answers itself.
		"a chain of fallbacks": `{"nodes": [
			{"id": "s1", "kind": "http", ` + get + `, "outputs": [{"status": 404}]}, {"id": "f1", "kind": "http", ` + get + `}, {"id": "e1", "kind": "transform", "expr": "1"},
			{"id": "s2", "kind": "http", ` + get + `, "outputs": [{"status": 404}]}, {"id": "f2", "kind": "http", ` + get + `}, {"id": "e2", "kind": "transform", "expr": "2"},
			{"id": "done", "kind": "transform", "expr": "1"}],
		  "edges": [{"from": "s1", "to": "e1"}, {"from": "s1", "to": "f1", "on": 404}, {"from": "f1", "to": "e1"}, {"from": "e1", "to": "s2"},
		            {"from": "s2", "to": "e2"}, {"from": "s2", "to": "f2", "on": 404}, {"from": "f2", "to": "e2"}, {"from": "e2", "to": "done"}],
		  "response": {"answers": [{"status": 200, "from": "done"}, {"status": 502, "from": "f1", "unhandled": true}, {"status": 503, "from": "f2", "unhandled": true}]}}`,
		// It answers itself, and its Unhandled takes its expr failing.
		"its answer, and its Unhandled's": `{"nodes": [
			{"id": "a", "kind": "http", ` + get + `, "outputs": [{"status": 404}]}, {"id": "e", "kind": "transform", "expr": "nodes.a.status", "unhandled": {"body": "null"}}],
		  "edges": [{"from": "a", "to": "e"}, {"from": "a", "to": "e", "on": 404}],
		  "response": {"answers": [{"status": 200, "from": "e"}, {"status": 500, "from": "e", "unhandled": true}]}}`,
		// Two ways one run can both bring are its expr's business.
		"ways that both come": `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}, {"id": "b", "kind": "transform", "expr": "2"},
			{"id": "e", "kind": "transform", "expr": "[nodes.a.body, nodes.b.body]"}],
		  "edges": [{"from": "a", "to": "e"}, {"from": "b", "to": "e"}],
		  "response": {"answers": [{"status": 200, "from": "e"}]}}`,
		// Joined to two answers, it picks one.
		"picking its answer": `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}, {"id": "e", "kind": "transform", "expr": "{ 'status': 201 }"}],
		  "edges": [{"from": "a", "to": "e"}],
		  "response": {"answers": [{"status": 200, "from": "e"}, {"status": 201, "from": "e"}]}}`,
		// success_200 answers by crm or, prefs answering 400, by test_400,
		// and bad_400, by crm's 400, stays apart from both.
		"either way to one answer, another kept apart": `{"nodes": [
			{"id": "people", "kind": "http", ` + get + `}, {"id": "orders", "kind": "http", ` + get + `},
			{"id": "prefs", "kind": "http", ` + get + `, "outputs": [{"status": 400}]}, {"id": "crm", "kind": "http", ` + get + `, "outputs": [{"status": 400}]},
			{"id": "test_400", "kind": "http", ` + get + `}, {"id": "success_200", "kind": "transform", "expr": "1"}, {"id": "bad_400", "kind": "transform", "expr": "2"}],
		  "edges": [{"from": "people", "to": "orders"}, {"from": "people", "to": "prefs"}, {"from": "orders", "to": "crm"}, {"from": "prefs", "to": "crm"},
		            {"from": "prefs", "to": "test_400", "on": 400}, {"from": "crm", "to": "success_200"}, {"from": "test_400", "to": "success_200"},
		            {"from": "crm", "to": "bad_400", "on": 400}],
		  "response": {"answers": [{"status": 200, "from": "success_200"}, {"status": 400, "from": "bad_400"}]}}`,
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if ps := Validate(decode(t, def)); len(ps) > 0 {
				t.Fatalf("Validate() = %v, want no problems", ps)
			}
		})
	}
}

// A line into a transform marked required has to come, as a line into an
// http node does, so the old checks hold for it: two required lines that
// need one node to answer two ways never both come, and a transform whose
// required line needs a node's 2xx is kept apart from that node's 404.
// Only a transform's lines are marked: an http node needs every one.
func TestValidate_RequiredLines(t *testing.T) {
	t.Parallel()
	get := `"request": {"method": "GET", "url": "https://api.example.com/v1"}`
	nodes := `{"id": "a", "kind": "http", ` + get + `, "outputs": [{"status": 404}]}, {"id": "b", "kind": "transform", "expr": "1"},
		{"id": "t", "kind": "transform", "expr": "2"}`
	tests := []struct {
		name, def, want string
	}{
		{
			"one required, one not", `{"nodes": [` + nodes + `],
			  "edges": [{"from": "a", "to": "t", "required": true}, {"from": "b", "to": "t"}],
			  "response": {"answers": [{"status": 200, "from": "t"}, {"status": 404, "from": "a", "on": 404}]}}`,
			"",
		},
		{
			// Neither required, t can come by b alone, with a's 404.
			"none required", `{"nodes": [` + nodes + `],
			  "edges": [{"from": "a", "to": "t"}, {"from": "b", "to": "t"}],
			  "response": {"answers": [{"status": 200, "from": "t"}, {"status": 404, "from": "a", "on": 404}]}}`,
			"/response/answers/1/from overlap: 200 (t) and 404 (a) can both be reached in one run: join both to one transform, which picks the answer",
		},
		{
			// t runs only after a's 2xx, so c, after a's 404, never comes to it.
			"a line its required one rules out", `{"nodes": [` + nodes + `, {"id": "c", "kind": "transform", "expr": "3"}],
			  "edges": [{"from": "a", "to": "c", "on": 404}, {"from": "a", "to": "t", "required": true}, {"from": "c", "to": "t"}]}`,
			"/edges/2 never_taken: c's line to t can never be taken when t runs: it needs a to answer 2xx and 404",
		},
		{
			// d follows a's 2xx too, so its line can come with the required one.
			"a line that comes with its required one", `{"nodes": [` + nodes + `, {"id": "d", "kind": "transform", "expr": "3"}],
			  "edges": [{"from": "a", "to": "d"}, {"from": "a", "to": "t", "required": true}, {"from": "d", "to": "t"}]}`,
			"",
		},
		{
			// h never runs, which is its problem; its line to t has none more.
			"a line from a step that never runs", `{"nodes": [` + nodes + `, {"id": "c", "kind": "transform", "expr": "3"},
			    {"id": "h", "kind": "http", ` + get + `}],
			  "edges": [{"from": "a", "to": "c", "on": 404}, {"from": "a", "to": "h"}, {"from": "c", "to": "h"},
			    {"from": "a", "to": "t", "required": true}, {"from": "h", "to": "t"}]}`,
			"/nodes/4 never_runs: h can never run: it needs a to answer 2xx and 404",
		},
		{
			"two required that never both come", `{"nodes": [` + nodes + `, {"id": "c", "kind": "transform", "expr": "3"}],
			  "edges": [{"from": "a", "to": "c", "on": 404}, {"from": "a", "to": "t", "required": true}, {"from": "c", "to": "t", "required": true}]}`,
			"/nodes/2 never_runs: t can never run: it needs a to answer 2xx and 404",
		},
		{
			"required into an http node", `{"nodes": [` + nodes + `, {"id": "h", "kind": "http", ` + get + `}],
			  "edges": [{"from": "b", "to": "h", "required": true}]}`,
			"/edges/0/required not_allowed: an http node needs every edge into it; required is for a transform's",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var got []string
			for _, p := range Validate(decode(t, tt.def)) {
				got = append(got, p.Pointer+" "+p.Code+": "+p.Detail)
			}
			if strings.Join(got, "\n") != tt.want {
				t.Errorf("problems:\n%s\nwant:\n%s", strings.Join(got, "\n"), tt.want)
			}
		})
	}
}

// A transform needs of a node only what each way needs of it, or rules
// out: b can come as a's way doesn't, so e answering is no sign of a's
// 2xx, and both answers can be reached. A way whose node never runs is left
// out, so e still needs a's 2xx there, and f, with no other way, never
// runs.
func TestValidate_ATransformsRoute(t *testing.T) {
	t.Parallel()
	get := `"request": {"method": "GET", "url": "https://api.example.com/v1"}`
	tests := []struct {
		name, def, want string
	}{
		{
			"a way that needs nothing of a", `{"nodes": [{"id": "a", "kind": "http", ` + get + `, "outputs": [{"status": 404}]}, {"id": "b", "kind": "transform", "expr": "1"}, {"id": "e", "kind": "transform", "expr": "1"}],
			  "edges": [{"from": "a", "to": "e"}, {"from": "b", "to": "e"}],
			  "response": {"answers": [{"status": 200, "from": "e"}, {"status": 404, "from": "a", "on": 404}]}}`,
			"/response/answers/1/from overlap: 200 (e) and 404 (a) can both be reached in one run: join both to one transform, which picks the answer",
		},
		{
			"ways that never come", `{"nodes": [{"id": "a", "kind": "http", ` + get + `, "outputs": [{"status": 404}]}, {"id": "b", "kind": "transform", "expr": "1"},
			    {"id": "c", "kind": "transform", "expr": "2"}, {"id": "d", "kind": "http", ` + get + `}, {"id": "e", "kind": "transform", "expr": "4"}, {"id": "f", "kind": "transform", "expr": "5"}],
			  "edges": [{"from": "a", "to": "b"}, {"from": "a", "to": "c", "on": 404}, {"from": "a", "to": "d"}, {"from": "c", "to": "d"},
			            {"from": "b", "to": "e"}, {"from": "d", "to": "e"}, {"from": "d", "to": "f"}],
			  "response": {"answers": [{"status": 200, "from": "e"}, {"status": 404, "from": "a", "on": 404}, {"status": 201, "from": "f"}]}}`,
			"/nodes/3 never_runs: d can never run: it needs a to answer 2xx and 404",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var got []string
			for _, p := range Validate(decode(t, tt.def)) {
				got = append(got, p.Pointer+" "+p.Code+": "+p.Detail)
			}
			if strings.Join(got, "\n") != tt.want {
				t.Errorf("problems:\n%s\nwant:\n%s", strings.Join(got, "\n"), tt.want)
			}
		})
	}
}

// An http node after a transform that also needs a node the transform's
// ways rule out, or one of them to answer otherwise, can never run; two
// transforms can leave it only not running.
func TestValidate_NeverRunsAfterATransform(t *testing.T) {
	t.Parallel()
	get := `"request": {"method": "GET", "url": "https://api.example.com/v1"}`
	ps := Validate(decode(t, `{"nodes": [
		{"id": "prefs", "kind": "http", `+get+`, "outputs": [{"status": 400}]}, {"id": "t", "kind": "http", `+get+`, "outputs": [{"status": 500}]},
		{"id": "e", "kind": "transform", "expr": "1"}, {"id": "d", "kind": "http", `+get+`}],
	  "edges": [{"from": "prefs", "to": "e"}, {"from": "prefs", "to": "t", "on": 400}, {"from": "t", "to": "e"},
	            {"from": "e", "to": "d"}, {"from": "t", "to": "d", "on": 500}]}`))
	var got []string
	for _, p := range ps {
		got = append(got, p.Pointer+" "+p.Code+": "+p.Detail)
	}
	want := "/nodes/3 never_runs: d can never run: it needs t to answer 500, and to answer 2xx or be skipped"
	if strings.Join(got, "\n") != want {
		t.Errorf("problems:\n%s\nwant:\n%s", strings.Join(got, "\n"), want)
	}
	ps = Validate(decode(t, `{"nodes": [
		{"id": "p", "kind": "http", `+get+`, "outputs": [{"status": 400}]}, {"id": "x", "kind": "http", `+get+`, "outputs": [{"status": 404}, {"status": 500}]},
		{"id": "e1", "kind": "transform", "expr": "1"}, {"id": "e2", "kind": "transform", "expr": "2"}, {"id": "d", "kind": "http", `+get+`}],
	  "edges": [{"from": "p", "to": "x", "on": 400}, {"from": "p", "to": "e1"}, {"from": "x", "to": "e1"}, {"from": "p", "to": "e2"}, {"from": "x", "to": "e2", "on": 404},
	            {"from": "e1", "to": "d"}, {"from": "e2", "to": "d"}, {"from": "x", "to": "d", "on": 500}]}`))
	if len(ps) != 1 || ps[0].Detail != "d can never run: it needs x to answer 500, and to be skipped" {
		t.Errorf("two transforms: problems %v", ps)
	}
}

// Positions are the editor's business. One for a node that isn't in the
// workflow is ignored, not reported.
func TestValidate_IgnoresPositions(t *testing.T) {
	t.Parallel()
	d := decode(t, `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}],
		"ui": {"positions": {"a": {"x": 0, "y": 0}, "gone": {"x": 120.5, "y": -40}}}}`)
	if ps := Validate(d); len(ps) > 0 {
		t.Fatalf("Validate() = %v, want no problems", ps)
	}
}

func TestValidate_ReportsEachProblem(t *testing.T) {
	t.Parallel()
	get := `"request": {"method": "GET", "url": "https://api.example.com/v1"}`
	tests := []struct {
		name string
		def  string
		want []string // "pointer code", in order
	}{
		{
			name: "missing id",
			def:  `{"nodes": [{"kind": "http", ` + get + `}]}`,
			want: []string{"/nodes/0/id required"},
		},
		{
			name: "id with a hyphen",
			def:  `{"nodes": [{"id": "fetch-user", "kind": "http", ` + get + `}]}`,
			want: []string{"/nodes/0/id invalid_id"},
		},
		{
			name: "id starting with a digit",
			def:  `{"nodes": [{"id": "1user", "kind": "http", ` + get + `}]}`,
			want: []string{"/nodes/0/id invalid_id"},
		},
		{
			name: "id longer than 64",
			def:  `{"nodes": [{"id": "` + strings.Repeat("a", 65) + `", "kind": "http", ` + get + `}]}`,
			want: []string{"/nodes/0/id invalid_id"},
		},
		{
			name: "duplicate id",
			def: `{"nodes": [{"id": "a", "kind": "http", ` + get + `},
			                 {"id": "a", "kind": "http", ` + get + `}]}`,
			want: []string{"/nodes/1/id duplicate_id"},
		},
		{
			name: "missing kind",
			def:  `{"nodes": [{"id": "a"}]}`,
			want: []string{"/nodes/0/kind required"},
		},
		{
			name: "unknown kind",
			def:  `{"nodes": [{"id": "a", "kind": "database"}]}`,
			want: []string{"/nodes/0/kind invalid_kind"},
		},
		{
			name: "http node without a request",
			def:  `{"nodes": [{"id": "a", "kind": "http"}]}`,
			want: []string{"/nodes/0/request required"},
		},
		{
			name: "http node with an expr",
			def:  `{"nodes": [{"id": "a", "kind": "http", "expr": "1", ` + get + `}]}`,
			want: []string{"/nodes/0/expr not_allowed"},
		},
		{
			name: "transform node without an expr",
			def:  `{"nodes": [{"id": "a", "kind": "transform"}]}`,
			want: []string{"/nodes/0/expr required"},
		},
		{
			name: "transform node with a request",
			def:  `{"nodes": [{"id": "a", "kind": "transform", "expr": "1", ` + get + `}]}`,
			want: []string{"/nodes/0/request not_allowed"},
		},
		{
			name: "missing method and url",
			def:  `{"nodes": [{"id": "a", "kind": "http", "request": {}}]}`,
			want: []string{"/nodes/0/request/method required", "/nodes/0/request/url required"},
		},
		{
			name: "unknown method",
			def:  `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "TRACE", "url": "https://x.example/"}}]}`,
			want: []string{"/nodes/0/request/method invalid_method"},
		},
		{
			name: "relative url",
			def:  `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "/v1/users"}}]}`,
			want: []string{"/nodes/0/request/url invalid_url"},
		},
		{
			name: "ftp url",
			def:  `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "ftp://x.example/f"}}]}`,
			want: []string{"/nodes/0/request/url invalid_url"},
		},
		{ //nolint:gosec // G101: the credentials are the point; validation must refuse them
			name: "credentials in the url",
			def:  `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "https://me:secret@x.example/"}}]}`,
			want: []string{"/nodes/0/request/url invalid_url"},
		},
		{
			name: "fragment in the url",
			def:  `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "https://x.example/a#b"}}]}`,
			want: []string{"/nodes/0/request/url invalid_url"},
		},
		{
			name: "placeholder in the host",
			def:  `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "https://{{ input.host }}/v1"}}]}`,
			want: []string{"/nodes/0/request/url placeholder_in_host"},
		},
		{
			name: "placeholder that could extend the host",
			def:  `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "https://x.example{{ input.path }}"}}]}`,
			want: []string{"/nodes/0/request/url placeholder_in_host"},
		},
		{
			name: "placeholder in the port",
			def:  `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "https://x.example:{{ input.port }}/"}}]}`,
			want: []string{"/nodes/0/request/url placeholder_in_host"},
		},
		{
			name: "invalid header name",
			def:  `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "https://x.example/", "headers": {"X Api/Key": "k"}}}]}`,
			want: []string{"/nodes/0/request/headers/X Api~1Key invalid_header_name"},
		},
		{
			name: "timeout out of range",
			def:  `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "https://x.example/", "timeout_ms": 300001}}]}`,
			want: []string{"/nodes/0/request/timeout_ms invalid_timeout"},
		},
		{
			name: "one attempt is no retry",
			def:  `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "https://x.example/", "retry": {"attempts": 1}}}]}`,
			want: []string{"/nodes/0/request/retry/attempts invalid_retry"},
		},
		{
			name: "edge to a missing node",
			def:  `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}], "edges": [{"from": "a", "to": "b"}]}`,
			want: []string{"/edges/0/to unknown_node"},
		},
		{
			name: "edge without ends",
			def:  `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}], "edges": [{}]}`,
			want: []string{"/edges/0/from required", "/edges/0/to required"},
		},
		{
			name: "self edge",
			def:  `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}], "edges": [{"from": "a", "to": "a"}]}`,
			want: []string{"/edges/0 self_edge"},
		},
		{
			name: "duplicate edge",
			def: `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}, {"id": "b", "kind": "transform", "expr": "1"}],
			       "edges": [{"from": "a", "to": "b"}, {"from": "a", "to": "b", "when": "true"}]}`,
			want: []string{"/edges/1 duplicate_edge"},
		},
		{
			name: "cycle, and the node behind it isn't blamed",
			def: `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}, {"id": "b", "kind": "transform", "expr": "1"},
			                 {"id": "c", "kind": "transform", "expr": "1"}, {"id": "d", "kind": "transform", "expr": "1"}],
			       "edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "c"}, {"from": "c", "to": "a"}, {"from": "c", "to": "d"}]}`,
			want: []string{"/edges/0 cycle", "/edges/1 cycle", "/edges/2 cycle"},
		},
		{
			name: "a header with no name",
			def:  `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "https://api.example.com/v1", "headers": {"": "1"}}}]}`,
			want: []string{"/nodes/0/request/headers/ invalid_header_name"},
		},
		{
			name: "a sample on a transform node",
			def:  `{"nodes": [{"id": "a", "kind": "transform", "expr": "1", "sample": {"body": {}}}]}`,
			want: []string{"/nodes/0/sample not_allowed"},
		},
		{
			name: "a sample without a body",
			def:  `{"nodes": [{"id": "a", "kind": "http", ` + get + `, "sample": {"status": 200}}]}`,
			want: []string{"/nodes/0/sample/body required"},
		},
		{
			name: "a sample's status out of range",
			def:  `{"nodes": [{"id": "a", "kind": "http", ` + get + `, "sample": {"status": 99, "body": null}}]}`,
			want: []string{"/nodes/0/sample/status invalid_status"},
		},
		{
			name: "a sample's status outside 2xx",
			def:  `{"nodes": [{"id": "a", "kind": "http", ` + get + `, "sample": {"status": 404, "body": null}}]}`,
			want: []string{"/nodes/0/sample/status invalid_status"},
		},
		{
			name: "outputs on a transform node",
			def:  `{"nodes": [{"id": "a", "kind": "transform", "expr": "1", "outputs": [{"status": 404}]}]}`,
			want: []string{"/nodes/0/outputs not_allowed"},
		},
		{
			name: "an output's status in 2xx, and past 599",
			def:  `{"nodes": [{"id": "a", "kind": "http", ` + get + `, "outputs": [{"status": 204}, {"status": 600}]}]}`,
			want: []string{"/nodes/0/outputs/0/status invalid_status", "/nodes/0/outputs/1/status invalid_status"},
		},
		{
			name: "an output listed twice",
			def:  `{"nodes": [{"id": "a", "kind": "http", ` + get + `, "outputs": [{"status": 404}, {"status": 404}]}]}`,
			want: []string{"/nodes/0/outputs/1/status duplicate_output"},
		},
		{
			name: "an output's sample with a status of its own, and one without a body",
			def: `{"nodes": [{"id": "a", "kind": "http", ` + get + `,
			                  "outputs": [{"status": 404, "sample": {"status": 200, "body": null}}, {"status": 409, "sample": {}}]}]}`,
			want: []string{"/nodes/0/outputs/0/sample/status not_allowed", "/nodes/0/outputs/1/sample/body required"},
		},
		{
			name: "an edge on an output its source doesn't have",
			def: `{"nodes": [{"id": "a", "kind": "http", ` + get + `, "outputs": [{"status": 404}]}, {"id": "b", "kind": "transform", "expr": "1"}],
			       "edges": [{"from": "a", "to": "b", "on": 409}]}`,
			want: []string{"/edges/0/on unknown_output"},
		},
		{
			name: "an edge on an output from a transform",
			def: `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}, {"id": "b", "kind": "transform", "expr": "1"}],
			       "edges": [{"from": "a", "to": "b", "on": 404}]}`,
			want: []string{"/edges/0/on not_allowed"},
		},
		{
			name: "two edges on one output",
			def: `{"nodes": [{"id": "a", "kind": "http", ` + get + `, "outputs": [{"status": 404}]}, {"id": "b", "kind": "transform", "expr": "1"}],
			       "edges": [{"from": "a", "to": "b", "on": 404}, {"from": "a", "to": "b", "on": 404}]}`,
			want: []string{"/edges/1 duplicate_edge"},
		},
		{
			name: "a sample's header name with a space",
			def:  `{"nodes": [{"id": "a", "kind": "http", ` + get + `, "sample": {"headers": {"X Bad": "1"}, "body": 1}}]}`,
			want: []string{"/nodes/0/sample/headers/X Bad invalid_header_name"},
		},
		{
			name: "a sample's body over 64 KiB",
			def:  `{"nodes": [{"id": "a", "kind": "http", ` + get + `, "sample": {"body": "` + strings.Repeat("x", 64<<10) + `"}}]}`,
			want: []string{"/nodes/0/sample/body too_large"},
		},
		{
			name: "a sample input over 64 KiB",
			def:  `{"nodes": [], "sample_input": "` + strings.Repeat("x", 64<<10) + `"}`,
			want: []string{"/sample_input too_large"},
		},
		{
			name: "an answer no node is joined to",
			def:  `{"nodes": [], "response": {"answers": [{"status": 200}]}}`,
			want: []string{"/response/answers/0/from required"},
		},
		{
			name: "an answer from a node that doesn't exist",
			def:  `{"nodes": [], "response": {"answers": [{"status": 200, "from": "zz"}]}}`,
			want: []string{"/response/answers/0/from unknown_node"},
		},
		{
			name: "an answer on an output its node doesn't have",
			def:  `{"nodes": [{"id": "a", "kind": "http", ` + get + `}], "response": {"answers": [{"status": 404, "from": "a", "on": 404}]}}`,
			want: []string{"/response/answers/0/on unknown_output"},
		},
		{
			name: "an answer naming a transform's output",
			def:  `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}], "response": {"answers": [{"status": 200, "from": "a", "on": 404}]}}`,
			want: []string{"/response/answers/0/on not_allowed"},
		},
		{
			name: "a response with no answers",
			def:  `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}], "response": {}}`,
			want: []string{"/response/answers required"},
		},
		{
			name: "an answer with no status",
			def:  `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}], "response": {"answers": [{"from": "a"}]}}`,
			want: []string{"/response/answers/0/status required"},
		},
		{
			name: "an answer's status outside 200 to 599",
			def:  `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}], "response": {"answers": [{"status": 99, "from": "a"}]}}`,
			want: []string{"/response/answers/0/status invalid_status"},
		},
		{
			name: "two answers with one status",
			def:  `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}], "response": {"answers": [{"status": 200, "from": "a"}, {"status": 200, "from": "a"}]}}`,
			want: []string{"/response/answers/1/status duplicate_answer"},
		},
		{
			name: "one output of an http node joined to two answers",
			def:  `{"nodes": [{"id": "a", "kind": "http", ` + get + `}], "response": {"answers": [{"status": 200, "from": "a"}, {"status": 201, "from": "a"}]}}`,
			want: []string{"/response/answers/1/from not_allowed"},
		},
		{
			name: "two answers one run could both reach",
			def: `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}, {"id": "b", "kind": "transform", "expr": "2"}, {"id": "c", "kind": "transform", "expr": "3"}],
			       "edges": [{"from": "a", "to": "b"}, {"from": "a", "to": "c", "when": "false"}],
			       "response": {"answers": [{"status": 200, "from": "b"}, {"status": 400, "from": "c"}]}}`,
			want: []string{"/response/answers/1/from overlap"},
		},
		{
			name: "a case's exit joined to the answer of another status",
			def: `{"nodes": [{"id": "a", "kind": "transform", "switch": {"cases": [{"when": "true", "status": 404}, {"when": "true", "status": 200}]}}],
			       "response": {"answers": [{"status": 200, "from": "a", "on": 404}, {"status": 404, "from": "a", "on": 200}]}}`,
			want: []string{"/response/answers/0/from other_status", "/response/answers/1/from other_status"},
		},
		{
			name: "lines from a switch naming no case, or a status none gives",
			def: `{"nodes": [{"id": "a", "kind": "transform", "switch": {"cases": [{"when": "true", "status": 404}, {"when": "true", "status": 200}]}},
			                 {"id": "b", "kind": "transform", "expr": "1"}, {"id": "c", "kind": "transform", "expr": "2"}],
			       "edges": [{"from": "a", "to": "b"}, {"from": "a", "to": "c", "on": 418}],
			       "response": {"answers": [{"status": 404, "from": "a"}, {"status": 418, "from": "a", "on": 418}]}}`,
			want: []string{"/edges/0/on required", "/edges/1/on unknown_output", "/response/answers/0/on required", "/response/answers/1/on unknown_output"},
		},
		{
			name: "three cases with one status, and a switch with none",
			def: `{"nodes": [{"id": "a", "kind": "transform", "switch": {"cases": [{"when": "true", "status": 404}, {"when": "false", "status": 404}, {"when": "false", "status": 404}]}},
			                 {"id": "b", "kind": "transform", "switch": {"cases": []}}]}`,
			want: []string{"/nodes/0/switch/cases/1/status duplicate_output", "/nodes/0/switch/cases/2/status duplicate_output", "/nodes/1/switch/cases required"},
		},
		{
			name: "a case with no condition and a bad status",
			def:  `{"nodes": [{"id": "a", "kind": "transform", "switch": {"cases": [{"status": 99}, {"when": "true", "status": 0}, {"when": "true", "status": 600}]}}]}`,
			want: []string{"/nodes/0/switch/cases/0/when required", "/nodes/0/switch/cases/0/status invalid_status", "/nodes/0/switch/cases/1/status required", "/nodes/0/switch/cases/2/status invalid_status"},
		},
		{
			name: "a transform with an expr and a switch",
			def:  `{"nodes": [{"id": "a", "kind": "transform", "expr": "1", "switch": {"cases": [{"when": "true", "status": 200}]}}]}`,
			want: []string{"/nodes/0/switch not_allowed"},
		},
		{
			name: "an http node with a switch",
			def:  `{"nodes": [{"id": "a", "kind": "http", ` + get + `, "switch": {"cases": [{"when": "true", "status": 200}]}}]}`,
			want: []string{"/nodes/0/switch not_allowed"},
		},
		{
			// Reach isn't judged on a loop: the loop is what's wrong.
			name: "answers from a loop",
			def: `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}, {"id": "b", "kind": "transform", "expr": "2"}],
			       "edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "a"}],
			       "response": {"answers": [{"status": 200, "from": "a"}, {"status": 400, "from": "b"}]}}`,
			want: []string{"/edges/0 cycle", "/edges/1 cycle"},
		},
		{
			name: "unhandled with no body",
			def:  `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}], "response": {"answers": [{"status": 200, "from": "a"}], "unhandled": {"body": " "}}}`,
			want: []string{"/response/unhandled/body required"},
		},
		{
			name: "a line from both an output and Unhandled",
			def: `{"nodes": [{"id": "a", "kind": "http", ` + get + `, "outputs": [{"status": 404}]}, {"id": "b", "kind": "transform", "expr": "1"}],
			       "edges": [{"from": "a", "to": "b", "on": 404, "unhandled": true}],
			       "response": {"answers": [{"status": 200, "from": "b"}, {"status": 404, "from": "a", "on": 404, "unhandled": true}]}}`,
			want: []string{"/edges/0/unhandled not_allowed", "/response/answers/1/unhandled not_allowed"},
		},
		{
			name: "Unhandled joined to two answers, and twice to one node",
			def: `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}, {"id": "b", "kind": "transform", "expr": "2"}],
			       "edges": [{"from": "a", "to": "b", "unhandled": true}, {"from": "a", "to": "b", "unhandled": true}],
			       "response": {"answers": [{"status": 200, "from": "a"}, {"status": 500, "from": "a", "unhandled": true}, {"status": 503, "from": "a", "unhandled": true}]}}`,
			want: []string{"/edges/1 duplicate_edge", "/response/answers/2/from not_allowed"},
		},
		{
			name: "an Unhandled body with no JSONata",
			def:  `{"nodes": [{"id": "a", "kind": "transform", "expr": "1", "unhandled": {"body": " "}}]}`,
			want: []string{"/nodes/0/unhandled/body required"},
		},
		{
			// A transform merges now; a revision saved with a merge names a
			// kind that's gone.
			name: "a merge",
			def:  `{"nodes": [{"id": "e", "kind": "merge", "expr": "1"}]}`,
			want: []string{"/nodes/0/kind invalid_kind"},
		},
		{
			name: "an output beside a response",
			def:  `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}], "output": "1", "response": {"answers": [{"status": 200, "from": "a"}]}}`,
			want: []string{"/output not_allowed"},
		},
		{
			name: "every problem at once",
			def: `{"nodes": [{"id": "A", "kind": "http", "request": {"method": "GET", "url": "https://{{ input.h }}/"}},
			                 {"id": "b", "kind": "transform"}],
			       "edges": [{"from": "b", "to": "zz"}]}`,
			want: []string{"/nodes/0/id invalid_id", "/nodes/0/request/url placeholder_in_host", "/nodes/1/expr required", "/edges/0/to unknown_node"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var got []string
			for _, p := range Validate(decode(t, tt.def)) {
				if p.Detail == "" {
					t.Errorf("%s %s has no detail", p.Pointer, p.Code)
				}
				got = append(got, p.Pointer+" "+p.Code)
			}
			if strings.Join(got, "\n") != strings.Join(tt.want, "\n") {
				t.Errorf("problems:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(tt.want, "\n"))
			}
		})
	}
}

func TestValidate_TooManyNodes(t *testing.T) {
	t.Parallel()
	d := &Definition{}
	for i := range MaxNodes + 1 {
		d.Nodes = append(d.Nodes, Node{ID: "n" + strconv.Itoa(i), Kind: NodeKindTransform, Expr: "1"})
	}
	ps := Validate(d)
	if len(ps) != 1 || ps[0].Pointer != "/nodes" || ps[0].Code != "too_many_nodes" {
		t.Fatalf("Validate() = %v, want one too_many_nodes problem at /nodes", ps)
	}
}

func TestPointerTokens(t *testing.T) {
	t.Parallel()
	for pointer, want := range map[string]string{
		"":                     "",
		"/nodes/0/request/url": "nodes|0|request|url",
		"/a~1b/m~0n/~01":       "a/b|m~n|~1",
		"/":                    "",
	} {
		if got := strings.Join(PointerTokens(pointer), "|"); got != want {
			t.Errorf("PointerTokens(%q) = %q, want %q", pointer, got, want)
		}
	}
}

func TestProblems_Error(t *testing.T) {
	t.Parallel()
	ps := Problems{{Pointer: "/nodes/0/id", Code: "required", Detail: "a node needs an id"}, {Pointer: "/edges/0", Code: "cycle", Detail: "a loop"}}
	if got := ps.Error(); got != "invalid workflow: /nodes/0/id: a node needs an id; /edges/0: a loop" {
		t.Errorf("Error() = %q", got)
	}
}

// An http step whose lines need outputs of one step that share none can
// never run, and says so, whichever line it finds that on; the steps after
// it can't either, aren't named again, and their answers are no overlap.
// Two of one step's lines into another can never both be taken.
func TestValidate_NeverRuns(t *testing.T) {
	t.Parallel()
	get := `"request": {"method": "GET", "url": "https://api.example.com/v1"}`
	step := func(id string) string { return `{"id": "` + id + `", "kind": "http", ` + get + `}` }
	ps := Validate(decode(t, `{"nodes": [{"id": "a", "kind": "http", `+get+`, "outputs": [{"status": 404}, {"status": 409}]},
		`+step("b")+`, `+step("c")+`, `+step("d")+`, `+step("each_way")+`, `+step("later")+`, `+step("conflicted")+`, `+step("f")+`],
	  "edges": [
	    {"from": "a", "to": "b"}, {"from": "a", "to": "c", "on": 404}, {"from": "b", "to": "c"}, {"from": "c", "to": "d"},
	    {"from": "a", "to": "each_way"}, {"from": "a", "to": "each_way", "on": 404}, {"from": "a", "to": "each_way", "unhandled": true},
	    {"from": "b", "to": "later"}, {"from": "a", "to": "later", "on": 409},
	    {"from": "a", "to": "f", "on": 409}, {"from": "a", "to": "conflicted", "on": 404}, {"from": "a", "to": "conflicted"}, {"from": "f", "to": "conflicted"}],
	  "response": {"answers": [{"status": 201, "from": "b"}, {"status": 200, "from": "d"}]}}`))
	var got []string
	for _, p := range ps {
		got = append(got, p.Pointer+" "+p.Code+": "+p.Detail)
	}
	want := []string{
		"/nodes/4 never_runs: each_way can never run: it needs a to answer 2xx and 404",
		"/nodes/2 never_runs: c can never run: it needs a to answer 404 and 2xx",
		"/nodes/5 never_runs: later can never run: it needs a to answer 2xx and 409",
		"/nodes/6 never_runs: conflicted can never run: it needs a to answer 404 and 2xx",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("problems:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}
