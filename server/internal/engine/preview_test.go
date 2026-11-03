package engine

import (
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/Beasr1/conduit/server/internal/workflow"
)

// sampled is the roadmap's example with a sample response for each step
// before crm, and a sample input.
const sampled = `{
  "nodes": [
    {"id": "user", "kind": "http",
     "request": {"method": "GET", "url": "https://users.example.com/v1/users/{{ input.user_id }}"},
     "sample": {"headers": {"Content-Type": "application/json"}, "body": {"id": "7", "name": "Ada", "email": "ada@example.com"}}},
    {"id": "orders", "kind": "http",
     "request": {"method": "GET", "url": "https://orders.example.com/v1/orders", "query": {"user": "{{ nodes.user.body.id }}"}},
     "sample": {"body": [{"id": "o-1", "total": 30}, {"id": "o-2", "total": 12}]}},
    {"id": "prefs", "kind": "http",
     "request": {"method": "GET", "url": "https://prefs.example.com/v1/{{ nodes.user.body.id }}"},
     "sample": {"body": {"newsletter": true}}},
    {"id": "crm", "kind": "http",
     "request": {"method": "POST", "url": "https://crm.example.com/v1/contacts",
                 "headers": {"X-Orders": "{{ $count(nodes.orders.body) }}"},
                 "body": "{ 'email': nodes.user.body.email, 'newsletter': nodes.prefs.body.newsletter }"}}
  ],
  "edges": [
    {"from": "user", "to": "orders"}, {"from": "user", "to": "prefs"},
    {"from": "orders", "to": "crm"}, {"from": "prefs", "to": "crm"}
  ],
  "output": "{ 'contact': nodes.crm.body }",
  "sample_input": {"user_id": "7"}
}`

// previewOf decodes a definition, with edit applied to it first when given,
// and previews one of its steps.
func previewOf(t *testing.T, def, id string, edit func(*workflow.Definition)) *Preview {
	t.Helper()
	var d workflow.Definition
	if err := json.Unmarshal([]byte(def), &d); err != nil {
		t.Fatalf("decode definition: %v", err)
	}
	if edit != nil {
		edit(&d)
	}
	pv, err := Simulate(t.Context(), &d, id, workflow.Deps{})
	if err != nil {
		t.Fatalf("Simulate: %v", err)
	}
	return pv
}

func problemCodes(pv *Preview) string {
	var out []string
	for _, p := range pv.Problems {
		out = append(out, p.Pointer+" "+p.Code)
	}
	return strings.Join(out, ", ")
}

// sameJSON says whether two JSON texts hold the same value.
func sameJSON(t *testing.T, got json.RawMessage, want string) bool {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatalf("decode %s: %v", got, err)
	}
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatalf("decode %s: %v", want, err)
	}
	return reflect.DeepEqual(g, w)
}

func TestSimulate_ReadsTheSamplesAndRendersTheRequest(t *testing.T) {
	t.Parallel()
	pv := previewOf(t, sampled, "crm", nil)
	if p := problemCodes(pv); p != "" {
		t.Fatalf("problems: %s", p)
	}
	// What a run would give crm, with each sample standing in for its
	// response: header names in lower case, and 200 when no status is given.
	want := `{"input": {"user_id": "7"}, "nodes": {
		"user": {"status": 200, "headers": {"content-type": "application/json"}, "body": {"id": "7", "name": "Ada", "email": "ada@example.com"}},
		"orders": {"status": 200, "headers": {}, "body": [{"id": "o-1", "total": 30}, {"id": "o-2", "total": 12}]},
		"prefs": {"status": 200, "headers": {}, "body": {"newsletter": true}}}}`
	if !sameJSON(t, pv.Reads, want) {
		t.Errorf("reads %s", pv.Reads)
	}
	s := pv.Sends
	if s == nil || s.Method != "POST" || s.URL != "https://crm.example.com/v1/contacts" || s.Header.Get("X-Orders") != "2" {
		t.Fatalf("sends %+v", s)
	}
	if !sameJSON(t, s.Body, `{"email": "ada@example.com", "newsletter": true}`) {
		t.Errorf("body %s", s.Body)
	}
	// A request of its own reads the run, and has no parameters.
	if pv.Skipped || pv.Gives != nil || pv.Parameters != nil {
		t.Errorf("skipped %v, gives %s, parameters %s", pv.Skipped, pv.Gives, pv.Parameters)
	}
}

func TestSimulate_RendersPlaceholdersAndQuery(t *testing.T) {
	t.Parallel()
	pv := previewOf(t, sampled, "orders", nil)
	if pv.Sends == nil || pv.Sends.URL != "https://orders.example.com/v1/orders?user=7" {
		t.Fatalf("sends %+v", pv.Sends)
	}
	// orders runs after user only, so it reads nothing else.
	if !sameJSON(t, pv.Reads, `{"input": {"user_id": "7"}, "nodes": {"user": {"status": 200,
		"headers": {"content-type": "application/json"}, "body": {"id": "7", "name": "Ada", "email": "ada@example.com"}}}}`) {
		t.Errorf("reads %s", pv.Reads)
	}
}

func TestSimulate_EvaluatesTransformsOnTheWay(t *testing.T) {
	t.Parallel()
	def := `{"nodes": [
		{"id": "user", "kind": "http", "request": {"method": "GET", "url": "https://users.example.com/v1"},
		 "sample": {"body": {"name": "Ada"}}},
		{"id": "merge", "kind": "transform", "expr": "{ 'who': $uppercase(nodes.user.body.name) }"},
		{"id": "crm", "kind": "http", "request": {"method": "POST", "url": "https://crm.example.com/v1", "body": "nodes.merge.body"}}],
		"edges": [{"from": "user", "to": "merge"}, {"from": "merge", "to": "crm"}]}`
	pv := previewOf(t, def, "crm", nil)
	if pv.Sends == nil || !sameJSON(t, pv.Sends.Body, `{"who": "ADA"}`) {
		t.Fatalf("sends %+v, problems %s", pv.Sends, problemCodes(pv))
	}
	// And a transform previewed gives its value.
	if pv := previewOf(t, def, "merge", nil); !sameJSON(t, pv.Gives, `{"who": "ADA"}`) {
		t.Errorf("merge gives %s", pv.Gives)
	}
}

// A switch previews as it runs: the answer of its first case that holds.
// One whose case fails says which, and the steps after it read nothing of
// it.
func TestSimulate_Switch(t *testing.T) {
	t.Parallel()
	def := `{"nodes": [
		{"id": "user", "kind": "http", "request": {"method": "GET", "url": "https://users.example.com/v1"},
		 "sample": {"body": {"key": 1}}},
		{"id": "respond", "kind": "transform", "switch": {
		 "cases": [{"when": "nodes.user.body.key = 1", "status": 400, "body": "{ 'error': 'bad key' }"}, {"when": "true", "status": 200, "body": "nodes.user.body"}]}}],
		"edges": [{"from": "user", "to": "respond"}]}`
	if pv := previewOf(t, def, "respond", nil); !sameJSON(t, pv.Gives, `{"status": 400, "body": {"error": "bad key"}}`) || problemCodes(pv) != "" {
		t.Errorf("respond gives %s, problems %s", pv.Gives, problemCodes(pv))
	}
	broken := strings.Replace(def, "nodes.user.body.key = 1", "$number('x') = 1", 1)
	if pv := previewOf(t, broken, "respond", nil); problemCodes(pv) != "/nodes/1/switch/cases/0/when evaluation_failed" || pv.Gives != nil {
		t.Errorf("broken: problems %s, gives %s", problemCodes(pv), pv.Gives)
	}
	// A step after a case's exit runs when that case holds, reading the
	// status and body it gave; after another's, it's skipped.
	after := func(on int) func(*workflow.Definition) {
		return func(d *workflow.Definition) {
			d.Nodes = append(d.Nodes, workflow.Node{ID: "next", Kind: workflow.NodeKindTransform, Expr: "nodes.respond.status & ' ' & nodes.respond.body.error"})
			d.Edges = append(d.Edges, workflow.Edge{From: "respond", To: "next", On: on})
		}
	}
	if pv := previewOf(t, def, "next", after(400)); pv.Skipped || !sameJSON(t, pv.Gives, `"400 bad key"`) || problemCodes(pv) != "" {
		t.Errorf("after 400: skipped %v, gives %s, problems %s", pv.Skipped, pv.Gives, problemCodes(pv))
	}
	if pv := previewOf(t, def, "next", after(200)); !pv.Skipped {
		t.Errorf("after 200: skipped %v, gives %s", pv.Skipped, pv.Gives)
	}
}

// A step with no sample is named, never guessed at: what it would get back
// just isn't there to read.
func TestSimulate_NamesMissingSamples(t *testing.T) {
	t.Parallel()
	pv := previewOf(t, sampled, "crm", func(d *workflow.Definition) { d.Nodes[2].Sample = nil })
	if got := problemCodes(pv); got != "/nodes/2/sample missing_sample" {
		t.Errorf("problems %s", got)
	}
	var reads struct{ Nodes map[string]any }
	if err := json.Unmarshal(pv.Reads, &reads); err != nil || reads.Nodes["prefs"] != nil || reads.Nodes["user"] == nil {
		t.Errorf("reads %s", pv.Reads)
	}
	// JSONata leaves out a field whose value is undefined.
	if pv.Sends == nil || !sameJSON(t, pv.Sends.Body, `{"email": "ada@example.com"}`) {
		t.Errorf("sends %+v", pv.Sends)
	}
}

func TestSimulate_ReportsEachPartThatFails(t *testing.T) {
	t.Parallel()
	pv := previewOf(t, sampled, "crm", func(d *workflow.Definition) {
		d.SampleInput = json.RawMessage(`{"user_id": "7", "path": "a/b"}`)
		r := d.Nodes[3].Request
		r.URL = "https://crm.example.com/v1/{{ input.path }}"
		r.Headers["X-Bad"] = "{{ $number('x') }}"
	})
	got := problemCodes(pv)
	if got != "/nodes/3/request/url evaluation_failed, /nodes/3/request/headers/X-Bad evaluation_failed" {
		t.Errorf("problems %s", got)
	}
	// What did render is still there.
	if pv.Sends == nil || pv.Sends.URL != "" || pv.Sends.Header.Get("X-Orders") != "2" || pv.Sends.Body == nil {
		t.Errorf("sends %+v", pv.Sends)
	}
}

func TestSimulate_FollowsConditions(t *testing.T) {
	t.Parallel()
	notSeven := func(d *workflow.Definition) { d.Edges[0].When = "nodes.user.body.id = '8'" }
	if pv := previewOf(t, sampled, "orders", notSeven); !pv.Skipped || pv.Sends != nil {
		t.Errorf("orders: skipped %v, sends %+v", pv.Skipped, pv.Sends)
	}
	// crm needs orders as well as prefs, so it's skipped too, though prefs's
	// connection is taken.
	pv := previewOf(t, sampled, "crm", notSeven)
	if !pv.Skipped || pv.Sends != nil {
		t.Errorf("crm: skipped %v, sends %+v, problems %s", pv.Skipped, pv.Sends, problemCodes(pv))
	}
	// And a step that runs but takes no connection into crm keeps it from
	// running, though orders's is taken.
	prefsOff := func(d *workflow.Definition) { d.Edges[3].When = "false" }
	if pv := previewOf(t, sampled, "crm", prefsOff); !pv.Skipped {
		t.Errorf("crm without prefs's connection: skipped %v, problems %s", pv.Skipped, problemCodes(pv))
	}
}

func TestSimulate_PreviewsTheOutput(t *testing.T) {
	t.Parallel()
	pv := previewOf(t, sampled, "", func(d *workflow.Definition) {
		d.Nodes[3].Sample = &workflow.Sample{Status: 201, Body: json.RawMessage(`{"id": "c-1"}`)}
	})
	if !sameJSON(t, pv.Gives, `{"contact": {"id": "c-1"}}`) || problemCodes(pv) != "" {
		t.Errorf("gives %s, problems %s", pv.Gives, problemCodes(pv))
	}
}

// A draft being edited has problems elsewhere. The preview reports the
// ones in its way and ignores the rest.
func TestSimulate_WorksOnADefinitionWithProblems(t *testing.T) {
	t.Parallel()
	pv := previewOf(t, sampled, "crm", func(d *workflow.Definition) {
		d.Nodes = append(d.Nodes, workflow.Node{ID: "broken", Kind: workflow.NodeKindHTTP, Request: &workflow.HTTPRequest{Method: "GET"}})
		d.Nodes[3].Request.TimeoutMs = -1
	})
	if got := problemCodes(pv); got != "/nodes/3/request/timeout_ms invalid_timeout" {
		t.Errorf("problems %s", got)
	}
	if pv.Sends == nil || pv.Sends.URL != "https://crm.example.com/v1/contacts" {
		t.Errorf("sends %+v", pv.Sends)
	}
}

func TestSimulate_UnknownStep(t *testing.T) {
	t.Parallel()
	var d workflow.Definition
	if err := json.Unmarshal([]byte(sampled), &d); err != nil {
		t.Fatal(err)
	}
	if _, err := Simulate(t.Context(), &d, "nope", workflow.Deps{}); !errors.Is(err, ErrNoSuchNode) {
		t.Errorf("err = %v, want ErrNoSuchNode", err)
	}
}

func TestSimulate_StepOnALoop(t *testing.T) {
	t.Parallel()
	def := `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}, {"id": "b", "kind": "transform", "expr": "2"}],
		"edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "a"}]}`
	pv := previewOf(t, def, "b", nil)
	if got := problemCodes(pv); got != "/edges/0 cycle, /edges/1 cycle" {
		t.Errorf("problems %s", got)
	}
	if !sameJSON(t, pv.Reads, `{"input": null, "nodes": {}}`) || pv.Gives != nil {
		t.Errorf("reads %s, gives %s", pv.Reads, pv.Gives)
	}
}

// branched has user answer 2xx or 404, each with a sample: create follows
// the 404, crm the 2xx, and log either.
const branched = `{
  "nodes": [
    {"id": "user", "kind": "http", "request": {"method": "GET", "url": "https://users.example.com/v1/users/{{ input.user_id }}"},
     "sample": {"body": {"id": "7", "email": "ada@example.com"}},
     "outputs": [{"status": 409}, {"status": 404, "sample": {"body": {"error": "gone"}}}]},
    {"id": "create", "kind": "http", "request": {"method": "POST", "url": "https://users.example.com/v1/users",
     "body": "{ 'id': input.user_id, 'why': nodes.user.body.error }"}},
    {"id": "crm", "kind": "http", "request": {"method": "POST", "url": "https://crm.example.com/v1/contacts",
     "body": "{ 'email': nodes.user.body.email }"}, "sample": {"body": {"id": "c-1"}}},
    {"id": "log", "kind": "transform", "expr": "nodes.user.status"}
  ],
  "edges": [
    {"from": "user", "to": "create", "on": 404},
    {"from": "user", "to": "crm"},
    {"from": "user", "to": "log", "on": 404},
    {"from": "user", "to": "log"}
  ],
  "output": "{ 'crm': nodes.crm.body.id, 'created': $exists(nodes.create) }",
  "sample_input": {"user_id": "7"}
}`

// Each step on the way answers with the sample of the output that leads to
// the step previewed, 2xx when several do, and a transform two of whose
// lines may come is previewed by each. The output reads every step's 2xx.
func TestSimulate_AnswersThroughTheOutputThatLeadsThere(t *testing.T) {
	t.Parallel()
	pv := previewOf(t, branched, "create", nil)
	if pv.Skipped || pv.Sends == nil || !sameJSON(t, pv.Sends.Body, `{"id": "7", "why": "gone"}`) || problemCodes(pv) != "" {
		t.Errorf("create: skipped %v, sends %+v, problems %s", pv.Skipped, pv.Sends, problemCodes(pv))
	}
	pv = previewOf(t, branched, "crm", nil)
	if pv.Skipped || pv.Sends == nil || !sameJSON(t, pv.Sends.Body, `{"email": "ada@example.com"}`) {
		t.Errorf("crm: skipped %v, sends %+v", pv.Skipped, pv.Sends)
	}
	if pv := previewOf(t, branched, "log", nil); len(pv.Ways) != 2 || !sameJSON(t, pv.Ways[0].Gives, `404`) || !sameJSON(t, pv.Ways[1].Gives, `200`) {
		t.Errorf("log's ways %+v", pv.Ways)
	}
	if pv := previewOf(t, branched, "", nil); !sameJSON(t, pv.Gives, `{"crm": "c-1", "created": false}`) {
		t.Errorf("output gives %s, problems %s", pv.Gives, problemCodes(pv))
	}
}

// A sample whose body isn't JSON, which only a caller other than the API can
// hand over, is said to fail where it is.
func TestSimulate_ASampleThatIsntJSON(t *testing.T) {
	t.Parallel()
	pv := previewOf(t, branched, "crm", func(d *workflow.Definition) { d.Nodes[0].Sample.Body = json.RawMessage(`{`) })
	if got := problemCodes(pv); got != "/nodes/0/sample evaluation_failed" {
		t.Errorf("problems %s", got)
	}
}

// An output with no sample is named where it would be; the step after it
// still previews, as it might run.
func TestSimulate_NamesAnOutputsMissingSample(t *testing.T) {
	t.Parallel()
	pv := previewOf(t, branched, "create", func(d *workflow.Definition) { d.Nodes[0].Outputs[1].Sample = nil })
	if got := problemCodes(pv); got != "/nodes/0/outputs/1/sample missing_sample" {
		t.Errorf("problems %s", got)
	}
	if pv.Skipped || pv.Sends == nil || !sameJSON(t, pv.Sends.Body, `{"id": "7"}`) {
		t.Errorf("skipped %v, sends %+v", pv.Skipped, pv.Sends)
	}
}

// edgePreviewOf decodes a definition, with edit applied to it first when
// given, and previews one of its connections.
func edgePreviewOf(t *testing.T, def string, k int, edit func(*workflow.Definition)) *Preview {
	t.Helper()
	var d workflow.Definition
	if err := json.Unmarshal([]byte(def), &d); err != nil {
		t.Fatalf("decode definition: %v", err)
	}
	if edit != nil {
		edit(&d)
	}
	pv, err := SimulateEdge(t.Context(), &d, k, workflow.Deps{})
	if err != nil {
		t.Fatalf("SimulateEdge: %v", err)
	}
	return pv
}

func taken(pv *Preview) string {
	if pv.Taken == nil {
		return "unknown"
	}
	return strconv.FormatBool(*pv.Taken)
}

// A connection's preview reads what its condition reads, with its source
// answering through the connection's output, and says if it's taken.
func TestSimulateEdge_SaysWhetherItsTaken(t *testing.T) {
	t.Parallel()
	pv := edgePreviewOf(t, branched, 0, nil)
	if taken(pv) != "true" || pv.Skipped || problemCodes(pv) != "" ||
		!sameJSON(t, pv.Reads, `{"input": {"user_id": "7"}, "nodes": {"user": {"status": 404, "headers": {}, "body": {"error": "gone"}}}}`) {
		t.Errorf("on 404: taken %s, skipped %v, reads %s, problems %s", taken(pv), pv.Skipped, pv.Reads, problemCodes(pv))
	}
	pv = edgePreviewOf(t, branched, 0, func(d *workflow.Definition) { d.Edges[0].When = "nodes.user.body.error = 'expired'" })
	if taken(pv) != "false" {
		t.Errorf("a condition that doesn't hold: taken %s", taken(pv))
	}
	pv = edgePreviewOf(t, branched, 1, nil)
	if taken(pv) != "true" || !strings.Contains(string(pv.Reads), `"status":200`) {
		t.Errorf("on 2xx: taken %s, reads %s", taken(pv), pv.Reads)
	}
}

// When it can't tell, it says why: a condition that fails, a missing
// sample, an end that names no step. A source a run would skip takes no
// connection.
func TestSimulateEdge_WhenItCantTell(t *testing.T) {
	t.Parallel()
	pv := edgePreviewOf(t, branched, 0, func(d *workflow.Definition) { d.Edges[0].When = "$number('x')" })
	if taken(pv) != "unknown" || problemCodes(pv) != "/edges/0/when evaluation_failed" {
		t.Errorf("failing condition: taken %s, problems %s", taken(pv), problemCodes(pv))
	}
	pv = edgePreviewOf(t, branched, 0, func(d *workflow.Definition) { d.Nodes[0].Outputs[1].Sample = nil })
	if taken(pv) != "unknown" || problemCodes(pv) != "/nodes/0/outputs/1/sample missing_sample" {
		t.Errorf("missing sample: taken %s, problems %s", taken(pv), problemCodes(pv))
	}
	pv = edgePreviewOf(t, branched, 0, func(d *workflow.Definition) { d.Edges[0].To = "nope" })
	if taken(pv) != "unknown" || problemCodes(pv) != "/edges/0/to unknown_node" || !sameJSON(t, pv.Reads, `{"input": {"user_id": "7"}, "nodes": {}}`) {
		t.Errorf("no such step: taken %s, problems %s, reads %s", taken(pv), problemCodes(pv), pv.Reads)
	}
	pv = edgePreviewOf(t, branched, 0, func(d *workflow.Definition) { d.Edges[0].When = "$sum(" })
	if taken(pv) != "unknown" || problemCodes(pv) != "/edges/0/when invalid_expression" {
		t.Errorf("a condition that doesn't compile: taken %s, problems %s", taken(pv), problemCodes(pv))
	}
	pv = edgePreviewOf(t, branched, 0, func(d *workflow.Definition) { d.Edges[0].On = 500 })
	if taken(pv) != "unknown" || problemCodes(pv) != "/edges/0/on unknown_output" {
		t.Errorf("a response user lacks: taken %s, problems %s", taken(pv), problemCodes(pv))
	}
	loop := `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}, {"id": "b", "kind": "transform", "expr": "2"}],
		"edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "a"}]}`
	pv = edgePreviewOf(t, loop, 0, nil)
	if taken(pv) != "unknown" || problemCodes(pv) != "/edges/0 cycle, /edges/1 cycle" || !sameJSON(t, pv.Reads, `{"input": null, "nodes": {}}`) {
		t.Errorf("on a loop: taken %s, problems %s, reads %s", taken(pv), problemCodes(pv), pv.Reads)
	}
	pv = edgePreviewOf(t, branched, 0, func(d *workflow.Definition) {
		d.Nodes = append(d.Nodes, workflow.Node{ID: "gate", Kind: workflow.NodeKindTransform, Expr: "1"})
		d.Edges = append(d.Edges, workflow.Edge{From: "gate", To: "user", When: "false"})
	})
	if taken(pv) != "false" || !pv.Skipped {
		t.Errorf("skipped source: taken %s, skipped %v", taken(pv), pv.Skipped)
	}
	var d workflow.Definition
	if err := json.Unmarshal([]byte(branched), &d); err != nil {
		t.Fatal(err)
	}
	if _, err := SimulateEdge(t.Context(), &d, 4, workflow.Deps{}); !errors.Is(err, ErrNoSuchEdge) {
		t.Errorf("err = %v, want ErrNoSuchEdge", err)
	}
}

// A run sends a retried POST with an Idempotency-Key it makes from its own
// id; the preview says where that goes.
func TestSimulate_ShowsTheIdempotencyKey(t *testing.T) {
	t.Parallel()
	pv := previewOf(t, sampled, "crm", func(d *workflow.Definition) {
		d.Nodes[3].Request.Retry = &workflow.Retry{Attempts: 3, Idempotent: true}
	})
	if got := pv.Sends.Header.Get("Idempotency-Key"); got != "<run id>:crm" {
		t.Errorf("Idempotency-Key = %q", got)
	}
}

// A part that doesn't compile can't render: it's left out of what's sent,
// and its problem says why.
func TestSimulate_LeavesOutPartsThatDontCompile(t *testing.T) {
	t.Parallel()
	pv := previewOf(t, sampled, "crm", func(d *workflow.Definition) {
		r := d.Nodes[3].Request
		r.Headers["X-Bad"] = "{{ nodes. }}"
		r.Query = map[string]string{"q": "{{ $sum( }}"}
		r.Body = "{ 'a': "
	})
	got := problemCodes(pv)
	if got != "/nodes/3/request/headers/X-Bad invalid_expression, /nodes/3/request/query/q invalid_expression, /nodes/3/request/body invalid_expression" {
		t.Errorf("problems %s", got)
	}
	s := pv.Sends
	if s == nil || s.URL != "https://crm.example.com/v1/contacts" || s.Header.Get("X-Bad") != "" || s.Body != nil {
		t.Errorf("sends %+v", s)
	}
}

// An expression or a condition failing on the way is reported where it is,
// and the step still previews, with what it couldn't get left out.
func TestSimulate_ReportsWhatFailsOnTheWay(t *testing.T) {
	t.Parallel()
	def := `{"nodes": [
		{"id": "user", "kind": "http", "request": {"method": "GET", "url": "https://users.example.com/v1"},
		 "sample": {"body": {"id": "7"}}},
		{"id": "bad", "kind": "transform", "expr": "$number('x')"},
		{"id": "crm", "kind": "http", "request": {"method": "POST", "url": "https://crm.example.com/v1", "body": "nodes.bad.body"}}],
		"edges": [{"from": "user", "to": "bad"}, {"from": "bad", "to": "crm"},
		          {"from": "user", "to": "crm", "when": "$number('y') > 0"}]}`
	pv := previewOf(t, def, "crm", nil)
	got := problemCodes(pv)
	// In the order a run meets them: user's conditions, then bad, then crm.
	if got != "/edges/2/when evaluation_failed, /nodes/1/expr evaluation_failed, /nodes/2/request/body evaluation_failed" {
		t.Errorf("problems %s", got)
	}
	if pv.Skipped || pv.Sends == nil || pv.Sends.URL != "https://crm.example.com/v1" {
		t.Errorf("skipped %v, sends %+v", pv.Skipped, pv.Sends)
	}
	// And previewed itself, the failing transform says so.
	if pv := previewOf(t, def, "bad", nil); problemCodes(pv) != "/nodes/1/expr evaluation_failed" || pv.Gives != nil {
		t.Errorf("bad: problems %s, gives %s", problemCodes(pv), pv.Gives)
	}
}

func TestSimulate_TheOutput(t *testing.T) {
	t.Parallel()
	// One that fails says so. crm has no sample, so the output can't read it.
	pv := previewOf(t, sampled, "", func(d *workflow.Definition) { d.Output = "$number('x')" })
	if problemCodes(pv) != "/nodes/3/sample missing_sample, /output evaluation_failed" || pv.Gives != nil {
		t.Errorf("problems %s, gives %s", problemCodes(pv), pv.Gives)
	}
	// With none, there's what it would read, and nothing it gives.
	pv = previewOf(t, sampled, "", func(d *workflow.Definition) { d.Output = "" })
	var reads struct{ Nodes map[string]any }
	if err := json.Unmarshal(pv.Reads, &reads); err != nil || len(reads.Nodes) != 3 || pv.Gives != nil {
		t.Errorf("reads %s, gives %s", pv.Reads, pv.Gives)
	}
}

// Of what's wrong with the definition, a preview reports only what's in its
// way: the sample input always, the output only when that's what it
// previews, and not a connection the canvas can't draw.
func TestSimulate_ReportsOnlyWhatsInTheWay(t *testing.T) {
	t.Parallel()
	broken := func(d *workflow.Definition) {
		d.SampleInput = json.RawMessage(`"` + strings.Repeat("x", 64<<10) + `"`)
		d.Output = "$sum("
		d.Edges = append(d.Edges, workflow.Edge{From: "crm", To: "zz"})
		d.Nodes = append(d.Nodes, workflow.Node{ID: "odd", Kind: "weird"})
		d.Edges = append(d.Edges, workflow.Edge{From: "odd", To: "crm"})
	}
	if got := problemCodes(previewOf(t, sampled, "crm", broken)); got != "/nodes/4/kind invalid_kind, /sample_input too_large" {
		t.Errorf("crm: problems %s", got)
	}
	if got := problemCodes(previewOf(t, sampled, "", broken)); got != "/nodes/4/kind invalid_kind, /sample_input too_large, /output invalid_expression, /nodes/3/sample missing_sample" {
		t.Errorf("output: problems %s", got)
	}
}

// A preview's problem points at the field that failed, so its words say
// only what went wrong there: a step's expression or Unhandled body before
// the one previewed, a connection's condition, and a case's body.
func TestSimulate_AProblemSaysWhatWentWrong(t *testing.T) {
	t.Parallel()
	pv := previewOf(t, `{
	  "nodes": [
	    {"id": "a", "kind": "transform", "expr": "1"},
	    {"id": "b", "kind": "transform", "switch": {"cases": [{"when": "true", "status": 200, "body": "$error('bust')"}]}},
	    {"id": "c", "kind": "transform", "expr": "$error('boom')"},
	    {"id": "d", "kind": "transform", "expr": "$error('fell')", "unhandled": {"body": "$error('caught')"}}
	  ],
	  "edges": [{"from": "a", "to": "b", "when": "$error('nope')"}, {"from": "c", "to": "b"}, {"from": "d", "to": "b", "unhandled": true}]
	}`, "b", nil)
	var got []string
	for _, p := range pv.Problems {
		got = append(got, p.Pointer+" "+p.Detail)
	}
	want := []string{"/edges/0/when D3137: nope", "/nodes/2/expr D3137: boom", "/nodes/3/unhandled/body D3137: caught", "/nodes/1/switch/cases/0/body D3137: bust"}
	if !slices.Equal(got, want) {
		t.Errorf("problems:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// A preview says what each step before the one previewed may have done in a
// run that reaches it, worked out from the lines whatever the samples, and
// a connection's says it of its source's; the output's says nothing.
func TestSimulate_Outcomes(t *testing.T) {
	t.Parallel()
	want := map[string]workflow.Outcome{
		"prefs":    {Outputs: []int{0, 400}},
		"fallback": {Outputs: []int{0}, Conditional: true},
	}
	if pv := previewOf(t, merged, "prefs_ok", nil); !reflect.DeepEqual(pv.Outcomes, want) {
		t.Errorf("prefs_ok's outcomes = %+v, want %+v", pv.Outcomes, want)
	}
	if pv := edgePreviewOf(t, merged, 3, nil); !reflect.DeepEqual(pv.Outcomes, want) {
		t.Errorf("the line from prefs_ok: outcomes = %+v, want %+v", pv.Outcomes, want)
	}
	if pv := previewOf(t, merged, "greet", nil); !pv.Outcomes["fallback"].Conditional || pv.Outcomes["prefs_ok"].Conditional {
		t.Errorf("greet's outcomes = %+v", pv.Outcomes)
	}
	if pv := previewOf(t, merged, "", nil); pv.Outcomes != nil {
		t.Errorf("the output's outcomes = %+v, want none", pv.Outcomes)
	}
}
