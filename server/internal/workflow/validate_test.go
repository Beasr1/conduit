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
// none, and two steps can be joined once per output: here log follows user
// whichever way it answered.
func TestValidate_AcceptsOutputs(t *testing.T) {
	t.Parallel()
	d := decode(t, `{"nodes": [
		{"id": "user", "kind": "http", "request": {"method": "GET", "url": "https://api.example.com/v1"},
		 "outputs": [{"status": 404, "sample": {"headers": {"Content-Type": "application/json"}, "body": {"error": "gone"}}},
		             {"status": 409}]},
		{"id": "create", "kind": "transform", "expr": "1"},
		{"id": "log", "kind": "transform", "expr": "1"}],
		"edges": [{"from": "user", "to": "create", "on": 404},
		          {"from": "user", "to": "log"},
		          {"from": "user", "to": "log", "on": 404}]}`)
	if ps := Validate(d); len(ps) > 0 {
		t.Fatalf("Validate() = %v, want no problems", ps)
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
