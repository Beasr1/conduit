package workflow

import (
	"reflect"
	"testing"
)

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
	got, ps := Resolve(d, vs)
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
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			d := decode(t, `{"nodes": [{"id": "user", `+tt.node+`}]}`)
			if _, ps := Resolve(d, library(t)); found(ps) != tt.want {
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
