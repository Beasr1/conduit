package workflow

import (
	"reflect"
	"strings"
	"testing"
)

// lookup is a node that uses revision 3 of w-lookup.
const lookup = `"kind": "http", "uses": {"workflow": "w-lookup", "revision": 3}`

// workflows holds the revisions nodes use: w-lookup at 3, taking a user's
// id and the fields to give, and answering 200, 201, 404 and 502; w-caller
// at 1; and w-middle at 2, which uses w-caller.
func workflows(t *testing.T) Revisions {
	t.Helper()
	return Revisions{
		{Workflow: "w-lookup", Revision: 3}: decode(t, `{"nodes": [], "input_schema": {"type": "object", "required": ["user_id"],
		    "properties": {"user_id": {"type": "string"}, "fields": {"type": "string"}}},
		  "response": {"answers": [{"status": 200}, {"status": 201}, {"status": 404}, {"status": 502}, {"status": 404}]}}`),
		{Workflow: "w-caller", Revision: 1}: decode(t, `{"nodes": []}`),
		{Workflow: "w-middle", Revision: 2}: decode(t, `{"nodes": [{"id": "back", "kind": "http", "uses": {"workflow": "w-caller", "revision": 1}}]}`),
	}
}

// A node that uses a workflow is filled from the revision it pins: the
// workflow's answers besides 2xx are its responses, each once, and each field
// of its input a parameter, the required ones required (plan 07).
func TestResolve_AWorkflow(t *testing.T) {
	t.Parallel()
	d := decode(t, `{"nodes": [{"id": "find", `+lookup+`, "with": {"user_id": "input.id"}, "unhandled": {"fail": true}},
	    {"id": "none", "kind": "transform", "expr": "'no such user'", "unhandled": {"fail": true}}],
	  "edges": [{"from": "find", "to": "none", "on": 404}]}`)
	got, ps := Resolve(d, Deps{Revisions: workflows(t)}, "w-caller")
	if len(ps) > 0 {
		t.Fatalf("Resolve() problems = %v", ps)
	}
	if n := got.Nodes[0]; !reflect.DeepEqual(n.Outputs, []Output{{Status: 404}, {Status: 502}}) || n.Request != nil || n.Sample != nil || n.With["user_id"] != "input.id" {
		t.Errorf("resolved node = %+v", n)
	}
	if d.Nodes[0].Outputs != nil {
		t.Errorf("Resolve changed the definition: %+v", d.Nodes[0])
	}
	if ps := Validate(got); len(ps) > 0 {
		t.Errorf("Validate(resolved) = %v", ps)
	}
}

// A workflow's input is its input schema's fields; with no schema, its
// sample input's; with neither, none.
func TestInputOf(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, def, fields, required string
	}{
		{"a schema's fields", `{"nodes": [], "input_schema": {"type": "object", "required": ["b"], "properties": {"b": {}, "a": {}}}, "sample_input": {"c": 1}}`, "a b", "b"},
		{"a sample's, with no schema", `{"nodes": [], "sample_input": {"id": "7", "all": true}}`, "all id", ""},
		{"a sample's, with a schema of no fields", `{"nodes": [], "input_schema": {"type": "object"}, "sample_input": {"id": "7"}}`, "id", ""},
		{"none, with neither", `{"nodes": [], "sample_input": [1]}`, "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			fields, required := InputOf(decode(t, tt.def))
			var req []string
			for _, f := range fields {
				if required[f] {
					req = append(req, f)
				}
			}
			if got, wantReq := strings.Join(fields, " "), strings.Join(req, " "); got != tt.fields || wantReq != tt.required {
				t.Errorf("InputOf() = %q, required %q; want %q, %q", got, wantReq, tt.fields, tt.required)
			}
		})
	}
}

// library holds one upstream at version 1: a user by id, with a 404.
func library(t *testing.T) Versions {
	t.Helper()
	return Versions{{Upstream: "u-users", Version: 1}: decodeUpstream(t, `{"parameters": [{"name": "user_id"}],
	  "request": {"method": "GET", "url": "https://users.example.com/v1/users/{{ user_id }}"},
	  "sample": {"body": {"id": "7"}}, "outputs": [{"status": 404}]}`)}
}

// A node that uses an upstream is filled from its version, so it's checked
// and run as an http node with that request, those responses and samples;
// it keeps its uses and with, and the definition it came from is as it was
// (plan 07).
func TestResolve_FillsFromTheVersion(t *testing.T) {
	t.Parallel()
	vs := library(t)
	d := decode(t, `{"nodes": [{"id": "user", "kind": "http", "uses": {"upstream": "u-users", "version": 1},
	    "with": {"user_id": "input.user_id"}, "unhandled": {"fail": true}},
	    {"id": "none", "kind": "transform", "expr": "'no such user'", "unhandled": {"fail": true}}],
	  "edges": [{"from": "user", "to": "none", "on": 404}]}`)
	got, ps := Resolve(d, Deps{Versions: vs}, "")
	if len(ps) > 0 {
		t.Fatalf("Resolve() problems = %v", ps)
	}
	n, u := got.Nodes[0], vs[Uses{Upstream: "u-users", Version: 1}]
	if n.Request == nil || !reflect.DeepEqual(*n.Request, u.Request) || !reflect.DeepEqual(n.Outputs, u.Outputs) || n.Sample != u.Sample ||
		n.Uses == nil || n.With["user_id"] != "input.user_id" {
		t.Errorf("resolved node = %+v", n)
	}
	if d.Nodes[0].Request != nil || d.Nodes[0].Outputs != nil {
		t.Errorf("Resolve changed the definition: %+v", d.Nodes[0])
	}
	// The edge on 404 leaves a response the version has.
	if ps := Validate(got); len(ps) > 0 {
		t.Errorf("Validate(resolved) = %v", ps)
	}
}

// What's wrong with how a node uses an upstream is said on the node.
func TestResolve_Problems(t *testing.T) {
	t.Parallel()
	uses := `"kind": "http", "uses": {"upstream": "u-users", "version": 1}`
	tests := []struct {
		name, node, want string
	}{
		{
			"a version not in the library", `"kind": "http", "uses": {"upstream": "u-users", "version": 3}, "with": {"user_id": "1"}`,
			"/nodes/0/uses unknown_upstream",
		},
		{"a parameter given no value", uses + `, "with": {}`, "/nodes/0/with/user_id required"},
		{"a parameter given an empty expression", uses + `, "with": {"user_id": " "}`, "/nodes/0/with/user_id required"},
		{"a value for no parameter", uses + `, "with": {"user_id": "1", "page": "2"}`, "/nodes/0/with/page unknown_parameter"},
		{
			"a request, responses and samples of its own", uses + `, "with": {"user_id": "1"},
		    "request": {"method": "GET", "url": "https://x.example.com"}, "outputs": [{"status": 404}], "sample": {"body": null}`,
			"/nodes/0/outputs not_allowed\n/nodes/0/request not_allowed\n/nodes/0/sample not_allowed",
		},
		{
			"values with no upstream", `"kind": "http", "request": {"method": "GET", "url": "https://x.example.com"}, "with": {"a": "1"}`,
			"/nodes/0/with not_allowed",
		},
		{
			"a transform that uses one", `"kind": "transform", "expr": "1", "uses": {"upstream": "u-users", "version": 1}`,
			"/nodes/0/uses not_allowed",
		},
		{"neither an upstream nor a workflow", `"kind": "http", "uses": {}`, "/nodes/0/uses required"},
		{
			"an upstream and a workflow", `"kind": "http", "uses": {"upstream": "u-users", "version": 1, "workflow": "w-lookup"}`,
			"/nodes/0/uses not_allowed",
		},
		{"an upstream at a revision", `"kind": "http", "uses": {"upstream": "u-users", "revision": 1}`, "/nodes/0/uses not_allowed"},
		{"a workflow at a version", `"kind": "http", "uses": {"workflow": "w-lookup", "version": 3}`, "/nodes/0/uses not_allowed"},
		{
			"a revision the workflow doesn't have", `"kind": "http", "uses": {"workflow": "w-lookup", "revision": 9}`,
			"/nodes/0/uses unknown_workflow",
		},
		{"a required input field given no value", lookup + `, "with": {"fields": "'name'"}`, "/nodes/0/with/user_id required"},
		{"a value for no input field", lookup + `, "with": {"user_id": "1", "page": "2"}`, "/nodes/0/with/page unknown_parameter"},
		{
			"a request, responses and samples of its own, with a workflow", lookup + `, "with": {"user_id": "1"},
		    "request": {"method": "GET", "url": "https://x.example.com"}, "outputs": [{"status": 404}], "sample": {"body": null}`,
			"/nodes/0/outputs not_allowed\n/nodes/0/request not_allowed\n/nodes/0/sample not_allowed",
		},
		{"the workflow itself", `"kind": "http", "uses": {"workflow": "w-caller", "revision": 1}`, "/nodes/0/uses uses_itself"},
		{"the workflow, through another", `"kind": "http", "uses": {"workflow": "w-middle", "revision": 2}`, "/nodes/0/uses uses_itself"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			d := decode(t, `{"nodes": [{"id": "user", `+tt.node+`}]}`)
			if _, ps := Resolve(d, Deps{Versions: library(t), Revisions: workflows(t)}, "w-caller"); found(ps) != tt.want {
				t.Errorf("Resolve() =\n%s\nwant\n%s", found(ps), tt.want)
			}
		})
	}
}

// An http node that uses no upstream needs a request; one that uses an
// upstream not in the library has that problem from Resolve, not this one.
func TestValidate_ANodeThatUsesAnUpstreamNeedsNoRequest(t *testing.T) {
	t.Parallel()
	d := decode(t, `{"nodes": [{"id": "user", "kind": "http", "uses": {"upstream": "u-users", "version": 3}}]}`)
	if ps := Validate(d); len(ps) > 0 {
		t.Errorf("Validate() = %v", ps)
	}
	if ps := found(Validate(decode(t, `{"nodes": [{"id": "user", "kind": "http"}]}`))); ps != "/nodes/0/request required" {
		t.Errorf("Validate() of a node with neither = %s", ps)
	}
}

// Using something archived is a problem on the node that does, as using
// something that isn't there is, and the node is still filled, so that's
// all that's said of it (plan 15). Through a workflow it pins, it's what
// that revision reaches, however far in: what its nodes use, and the
// constants those read; each said once, whichever way it's reached.
func TestResolve_Archived(t *testing.T) {
	t.Parallel()
	user := `"kind": "http", "uses": {"upstream": "u-users", "version": 1}, "with": {"user_id": "1"}, "unhandled": {"fail": true}`
	inner := Uses{Workflow: "w-inner", Revision: 1}
	outer := Uses{Workflow: "w-outer", Revision: 2}
	pinned := Uses{Upstream: "u-users", Version: 1}
	revisions := func(t *testing.T) Revisions {
		rs := workflows(t)
		rs[inner] = decode(t, `{"nodes": [{"id": "user", "kind": "http", "uses": {"upstream": "u-users", "version": 1}},
		    {"id": "again", "kind": "http", "uses": {"upstream": "u-users", "version": 1}}]}`)
		rs[outer] = decode(t, `{"nodes": [{"id": "in", "kind": "http", "uses": {"workflow": "w-inner", "revision": 1}},
		    {"id": "self", "kind": "http", "uses": {"workflow": "w-outer", "revision": 2}}]}`)
		return rs
	}
	users, crm := map[string]string{"u-users": "Users"}, map[string]string{"w-inner": "CRM lookup"}
	tests := []struct {
		name, node string
		archived   map[string]string
		reads      map[Uses][]string
		want       string
	}{
		{"nothing archived", user, nil, nil, ""},
		{"an upstream", user, users, nil, "/nodes/0/uses archived_upstream the upstream Users is archived: restore it, or use another"},
		{
			"a workflow", `"kind": "http", "uses": {"workflow": "w-inner", "revision": 1}`, crm, nil,
			"/nodes/0/uses archived_workflow the workflow CRM lookup is archived: restore it, or use another",
		},
		{
			"an upstream a workflow pins", `"kind": "http", "uses": {"workflow": "w-inner", "revision": 1}`, users, nil,
			"/nodes/0/uses archived_upstream the workflow it uses reaches the upstream Users, which is archived: restore it, or use another revision",
		},
		{
			"a workflow a workflow pins, and what it reaches", `"kind": "http", "uses": {"workflow": "w-outer", "revision": 2}`,
			map[string]string{"w-inner": "CRM lookup", "u-users": "Users"},
			nil,
			"/nodes/0/uses archived_workflow the workflow it uses reaches the workflow CRM lookup, which is archived: restore it, or use another revision\n" +
				"/nodes/0/uses archived_upstream the workflow it uses reaches the upstream Users, which is archived: restore it, or use another revision",
		},
		{
			"a constant a pinned revision reads", `"kind": "http", "uses": {"workflow": "w-inner", "revision": 1}`, nil,
			map[Uses][]string{inner: {"gone", "kept", "unknown"}},
			"/nodes/0/uses archived_constant the workflow it uses reads $const.gone, which is archived: restore it, or use another revision",
		},
		{
			"a constant a version it pins reads", `"kind": "http", "uses": {"workflow": "w-outer", "revision": 2}`, nil,
			map[Uses][]string{pinned: {"gone"}},
			"/nodes/0/uses archived_constant the workflow it uses reads $const.gone, which is archived: restore it, or use another revision",
		},
		// Its own request reads it, and Compile says so where it does.
		{"a constant the upstream it uses reads", user, nil, map[Uses][]string{pinned: {"gone"}}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			deps := Deps{
				Versions: library(t), Revisions: revisions(t), Archived: tt.archived, Reads: tt.reads,
				Constants: map[string]bool{"gone": false, "kept": true},
			}
			got, ps := Resolve(decode(t, `{"nodes": [{"id": "n", `+tt.node+`}]}`), deps, "w-caller")
			var said []string
			for _, p := range ps {
				said = append(said, p.Pointer+" "+p.Code+" "+p.Detail)
			}
			if s := strings.Join(said, "\n"); s != tt.want {
				t.Errorf("Resolve() =\n%s\nwant\n%s", s, tt.want)
			}
			if n := got.Nodes[0]; n.Uses.Upstream != "" && n.Request == nil {
				t.Errorf("the node isn't filled: %+v", n)
			}
		})
	}
}
