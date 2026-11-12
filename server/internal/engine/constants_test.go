package engine

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/Beasr1/conduit/server/internal/transform"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// Every expression reads constants by name, and only ones there are
// (plan 06): a name that isn't one, or $const as a whole, is a problem
// where it's read, whatever reads it.
func TestCompile_Constants(t *testing.T) {
	t.Parallel()
	known := map[string]bool{"crm_token": true, "base": true}
	def := `{
	  "nodes": [
	    {"id": "crm", "kind": "http", "uses": {"upstream": "u", "version": 1},
	     "with": {"token": "$const.crm_token", "other": "$const.missing_a"},
	     "request": {"method": "GET", "url": "{{ $const.base }}/v1/{{ $const.missing_b }}",
	                 "headers": {"X-Key": "{{ $string($const) }}"},
	                 "body": "{'k': $const.missing_c}"},
	     "unhandled": {"body": "$const.missing_d"}},
	    {"id": "pick", "kind": "transform",
	     "switch": {"cases": [{"when": "$const.missing_e = 'x'", "status": 200, "body": "$const.crm_token"}]}}
	  ],
	  "edges": [{"from": "crm", "to": "pick", "when": "$const.missing_f"}],
	  "output": "$const.missing_g"
	}`
	var d workflow.Definition
	if err := json.Unmarshal([]byte(def), &d); err != nil {
		t.Fatal(err)
	}
	_, err := Compile(&d, known)
	var ps workflow.Problems
	if !errors.As(err, &ps) {
		t.Fatalf("Compile() = %v, want problems", err)
	}
	var got []string
	for _, p := range ps {
		if p.Code == "unknown_constant" || p.Code == "whole_constants" {
			got = append(got, p.Pointer+" "+p.Code)
		}
	}
	slices.Sort(got)
	want := []string{
		"/edges/0/when unknown_constant",
		"/nodes/0/request/body unknown_constant",
		"/nodes/0/request/headers/X-Key whole_constants",
		"/nodes/0/request/url unknown_constant",
		"/nodes/0/unhandled/body unknown_constant",
		"/nodes/0/with/other unknown_constant",
		"/nodes/1/switch/cases/0/when unknown_constant",
		"/output unknown_constant",
	}
	if !slices.Equal(got, want) {
		t.Errorf("problems:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	for _, p := range ps {
		if p.Pointer == "/output" && p.Detail != "it reads $const.missing_g, which no constant is named: make it on the Constants page, or fix the name" {
			t.Errorf("unknown_constant says %q", p.Detail)
		}
	}
}

// An archived constant is there, so it's no unknown one, and no expression
// may read it (plan 15), while one in use reads as ever.
func TestCompile_ArchivedConstants(t *testing.T) {
	t.Parallel()
	known := map[string]bool{"gone": false, "kept": true}
	d := workflow.Definition{Nodes: []workflow.Node{{ID: "pick", Kind: workflow.NodeKindTransform, Expr: "$const.gone & $const.kept"}}}
	_, err := Compile(&d, known)
	var ps workflow.Problems
	if !errors.As(err, &ps) {
		t.Fatalf("Compile() = %v, want problems", err)
	}
	var got []string
	for _, p := range ps {
		if strings.HasSuffix(p.Code, "_constant") {
			got = append(got, p.Pointer+" "+p.Code+" "+p.Detail)
		}
	}
	want := []string{"/nodes/0/expr archived_constant it reads $const.gone, which is archived: restore it on the Constants page, or read another"}
	if !slices.Equal(got, want) {
		t.Errorf("problems:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// A run sends what a constant holds where its request reads one.
func TestRun_SendsConstants(t *testing.T) {
	t.Parallel()
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization") + " " + r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	p := program(t, srv.URL, `{"nodes": [{"id": "crm", "kind": "http",
	  "request": {"method": "GET", "url": "BASE/v1/{{ $const.tenant }}",
	              "headers": {"Authorization": "Bearer {{ $const.crm_token }}"}}}]}`)
	ctx := transform.WithConstants(t.Context(), map[string]string{"crm_token": "sk_live_1", "tenant": "acme"})
	res, err := testEngine(Options{}).Run(ctx, p, "run-1", json.RawMessage(`{}`), func(Event) {})
	if err != nil || res.Status != StatusSucceeded {
		t.Fatalf("Run() = %+v, %v", res, err)
	}
	if got != "Bearer sk_live_1 /v1/acme" {
		t.Errorf("the API got %q", got)
	}
}

// An upstream's request is checked for constants too, and for its
// parameters beside them.
func TestCheckUpstream_Constants(t *testing.T) {
	t.Parallel()
	u := workflow.Upstream{
		Parameters: []workflow.Parameter{{Name: "user_id"}},
		Request: workflow.HTTPRequest{
			Method:  "GET",
			URL:     "https://crm.example.com/{{ $const.tenant }}/{{ usr_id }}",
			Headers: map[string]string{"Authorization": "Bearer {{ $const.crm_token }}"},
		},
	}
	var got []string
	for _, p := range CheckUpstream(&u, map[string]bool{"tenant": true}) {
		got = append(got, p.Pointer+" "+p.Code)
	}
	slices.Sort(got)
	if want := []string{"/request/headers/Authorization unknown_constant", "/request/url unknown_parameter"}; !slices.Equal(got, want) {
		t.Errorf("CheckUpstream() = %q, want %q", got, want)
	}
}
