package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/runner"
	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/trace"
)

// serveDef is one step calling URL with the token, its failures failing
// the run, and its 2xx answering 200.
const serveDef = `{"nodes": [{"id": "call", "kind": "http", "unhandled": {"fail": true},
    "request": {"method": "POST", "url": "URL", "headers": {"Authorization": "Bearer ` + testToken + `"}, "body": "{}"}}],
  "response": {"answers": [{"status": 200, "lines": [{"from": "call"}]}]}}`

// servedAt stores serveDef, calling url, as a new workflow at slug, and
// publishes it: the slug comes first, as the step may call its own.
func servedAt(t *testing.T, slug, url string) store.Workflow {
	t.Helper()
	def := json.RawMessage(strings.ReplaceAll(serveDef, "URL", url))
	w, _, err := db.CreateWorkflow(t.Context(), slug, slug, def, store.Provenance{Actor: "token"})
	if err != nil {
		t.Fatal(err)
	}
	if w, err = db.Publish(t.Context(), w.ID, 1); err != nil {
		t.Fatal(err)
	}
	return w
}

// serve calls /serve/slug on srv with the token, and no trace of its own.
func serve(t *testing.T, srv *httptest.Server, slug string) reply {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, srv.URL+"/serve/"+slug, strings.NewReader("{}"))
	if err != nil {
		t.Error(err)
		return reply{}
	}
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("Content-Type", "application/json")
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Error(err)
		return reply{}
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return reply{status: res.StatusCode, header: res.Header, body: b}
}

// runsOf is a workflow's runs, newest first, as the API lists them.
func runsOf(t *testing.T, w store.Workflow) []gen.RunSummary {
	t.Helper()
	r := call(t, http.MethodGet, "/v1/runs?workflow_id="+w.ID, "")
	if r.status != http.StatusOK {
		t.Fatalf("list runs = %d %s", r.status, r.body)
	}
	return strict[gen.RunList](t, r.body).Runs
}

// A workflow calling its own /serve goes round trace.MaxHops times, its runs
// in one trace, and the call that would go round again is refused with 508
// before a run starts (plan 06).
func TestServe_AWorkflowCallingItselfStops(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(newRouter(db, runner.Options{}, 0))
	t.Cleanup(srv.Close)
	slug := newSlug(t)
	w := servedAt(t, slug, srv.URL+"/serve/"+slug)

	// Each turn fails on the one after it, so the caller's answer is the
	// first turn's failure.
	if r := serve(t, srv, slug); r.status != http.StatusBadGateway {
		t.Errorf("POST /serve/%s = %d %s, want 502", slug, r.status, r.body)
	}
	runs := runsOf(t, w)
	if len(runs) != trace.MaxHops {
		t.Fatalf("%d runs, want %d", len(runs), trace.MaxHops)
	}
	for _, run := range runs {
		if run.TraceID != runs[0].TraceID || len(run.TraceID) != 32 {
			t.Errorf("run %s in trace %q, want all in %q", run.ID, run.TraceID, runs[0].TraceID)
		}
	}
	last := strict[gen.Run](t, call(t, http.MethodGet, "/v1/runs/"+runs[0].ID, "").body)
	if last.TraceID != runs[0].TraceID || len(last.Nodes) != 1 || last.Nodes[0].Response.Status != http.StatusLoopDetected {
		t.Errorf("the last turn, in trace %q, got %+v; want its trace, and 508", last.TraceID, last.Nodes)
	}
}

// A call that has gone round already is refused with problem details naming
// its trace.
func TestServe_ALoopIs508(t *testing.T) {
	t.Parallel()
	slug := newSlug(t)
	servedAt(t, slug, "https://crm.example.com/v1")
	r := call(t, http.MethodPost, "/serve/"+slug, "{}",
		"Traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		"Tracestate", fmt.Sprintf("conduit=h:%d", trace.MaxHops))
	if r.status != http.StatusLoopDetected {
		t.Fatalf("POST /serve/%s = %d %s, want 508", slug, r.status, r.body)
	}
	if p := problemOf(t, r); p.Code != "loop" || !strings.Contains(p.Detail, "4bf92f3577b34da6a3ce929d0e0e4736") {
		t.Errorf("problem = %+v, want code loop, naming the trace", p)
	}
}

// A loop through an API that drops the trace can't be seen, so it's held to
// its workflow's share of the runs, a quarter: the call past it is refused
// with 503 before a run starts, and another workflow answers meanwhile.
func TestServe_ALoopThroughABlackBoxHoldsItsShare(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(newRouter(db, runner.Options{MaxRuns: 8}, 0)) // 2 runs each
	t.Cleanup(srv.Close)
	quick := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{}`) }))
	t.Cleanup(quick.Close)
	other := servedAt(t, newSlug(t), quick.URL)

	// The box calls the workflow back with none of the trace it was sent.
	// On its second call, with the workflow's two runs in progress, it
	// calls the other workflow first.
	var calls atomic.Int32
	var meanwhile, refused reply
	slug := newSlug(t)
	box := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 2 {
			meanwhile = serve(t, srv, other.Slug)
		}
		back := serve(t, srv, slug)
		if back.status == http.StatusServiceUnavailable {
			refused = back
		}
		w.WriteHeader(back.status)
	}))
	t.Cleanup(box.Close)
	w := servedAt(t, slug, box.URL)

	if r := serve(t, srv, slug); r.status != http.StatusBadGateway {
		t.Errorf("POST /serve/%s = %d %s, want 502", slug, r.status, r.body)
	}
	if calls.Load() != 2 || meanwhile.status != http.StatusOK {
		t.Errorf("the box was called %d times, and the other workflow answered %d, want 2 and 200", calls.Load(), meanwhile.status)
	}
	if p := problemOf(t, refused); p.Code != "busy" || !strings.Contains(p.Detail, "quarter") || refused.header.Get("Retry-After") == "" {
		t.Errorf("the third turn got %+v, Retry-After %q; want busy, a quarter", p, refused.header.Get("Retry-After"))
	}
	// Each turn started a trace of its own, as the box dropped it.
	if runs := runsOf(t, w); len(runs) != 2 || runs[0].TraceID == runs[1].TraceID {
		t.Errorf("runs = %+v, want 2 in traces of their own", runs)
	}
}
