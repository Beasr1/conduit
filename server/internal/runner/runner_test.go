package runner

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/store/storetest"
	"github.com/Beasr1/conduit/server/internal/trace"
	"github.com/Beasr1/conduit/server/internal/upstream"
)

var db *store.Store

func TestMain(m *testing.M) {
	os.Exit(storetest.Run(m, func(s *store.Store, _ string) { db = s }))
}

// newRunner reaches httptest servers, which listen on loopback. It's
// stopped, and its runs waited for, when the test ends.
func newRunner(t *testing.T, o Options) *Runner {
	t.Helper()
	r := New(db, upstream.New(upstream.Options{AllowPrivateNetworks: true}), slog.New(slog.DiscardHandler), o)
	t.Cleanup(func() {
		r.Stop()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := r.Wait(ctx); err != nil {
			t.Error(err)
		}
	})
	return r
}

// slug is unique per call, so tests never collide, even run repeatedly.
func slug(t *testing.T) string {
	t.Helper()
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return "wf-" + hex.EncodeToString(b)
}

// saveWorkflow stores def, with BASE standing for base, as a new workflow's
// revision 1, and publishes it.
func saveWorkflow(t *testing.T, base, def string) store.Workflow {
	t.Helper()
	ctx := t.Context()
	w, _, err := db.CreateWorkflow(ctx, slug(t), "test", json.RawMessage(strings.ReplaceAll(def, "BASE", base)), store.Provenance{Actor: "token"})
	if err != nil {
		t.Fatal(err)
	}
	if w, err = db.Publish(ctx, w.ID, 1); err != nil {
		t.Fatal(err)
	}
	return w
}

// collect follows a run from its start until its own event.
func collect(t *testing.T, r *Runner, runID string) []Event {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	w, err := r.Watch(ctx, runID, 0)
	if err != nil {
		t.Fatal(err)
	}
	return rest(t, ctx, w)
}

// rest is every event a watch has left, up to and including the run's own.
func rest(t *testing.T, ctx context.Context, w *Watch) []Event {
	t.Helper()
	var events []Event
	for {
		batch, err := w.Next(ctx)
		if errors.Is(err, io.EOF) {
			return events
		}
		if err != nil {
			t.Fatalf("Next: %v, after %s", err, seqs(events))
		}
		events = append(events, batch...)
	}
}

func decode[T any](t *testing.T, doc json.RawMessage) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(doc, &v); err != nil {
		t.Fatalf("decode %s: %v", doc, err)
	}
	return v
}

const greetDef = `{
  "nodes": [
    {"id": "user", "kind": "http", "request": {
      "method": "GET", "url": "BASE/users/{{ input.user_id }}",
      "headers": {"Authorization": "Bearer s3cret"},
      "query": {"api_key": "k-123", "page": "1"}}},
    {"id": "greet", "kind": "transform", "expr": "'Hello, ' & nodes.user.body.name"}
  ],
  "edges": [{"from": "user", "to": "greet"}],
  "output": "{ 'greeting': nodes.greet.body }",
  "input_schema": {"type": "object", "required": ["user_id"], "properties": {"user_id": {"type": "string"}}}
}`

func greetUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer s3cret" || r.URL.Path != "/users/7" {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		w.Header().Set("Set-Cookie", "sid=abc")
		fmt.Fprint(w, `{"id": "7", "name": "Ada"}`)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestStart_StreamsAndRecordsTheRun(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	r := newRunner(t, Options{})
	w := saveWorkflow(t, greetUpstream(t).URL, greetDef)

	run, err := r.Start(ctx, w.ID, 0, json.RawMessage(`{"user_id": "7"}`))
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != "running" || run.Trigger != "editor" || run.Revision != 1 {
		t.Errorf("started run = %+v", run)
	}
	events := collect(t, r, run.ID)
	if got, want := seqs(events), "1 user started, 2 user succeeded, 3 greet started, 4 greet succeeded, end run succeeded"; got != want {
		t.Fatalf("events = %s, want %s", got, want)
	}
	if e := events[1].Node; e.HTTPStatus != 200 || e.Attempt != 1 || e.Failure != nil {
		t.Errorf("user's end = %+v", e)
	}
	final := events[4].Run
	if string(final.Output) != `{"greeting": "Hello, Ada"}` || final.EndedAt == nil || final.Error != nil {
		t.Errorf("run event = %+v, output %s", final, final.Output)
	}

	nodes, err := db.NodeRuns(ctx, run.ID)
	if err != nil || len(nodes) != 2 {
		t.Fatalf("NodeRuns() = %+v, %v", nodes, err)
	}
	user, greet := nodes[0], nodes[1]
	req := decode[requestDoc](t, user.Request)
	if !strings.HasSuffix(req.URL, "/users/7?api_key=[redacted]&page=1") || req.Headers["authorization"] != redacted {
		t.Errorf("user's request, as stored = %s", user.Request)
	}
	res := decode[responseDoc](t, user.Response)
	if res.Status != 200 || res.Headers["set-cookie"] != redacted || string(res.Body) != `{"id": "7", "name": "Ada"}` {
		t.Errorf("user's response, as stored = %s", user.Response)
	}
	if user.StartedAt == nil || user.StartedAt.After(user.EndedAt) || user.Error != nil {
		t.Errorf("user = %+v", user)
	}
	if greet.Request != nil || string(greet.Response) != `{"body": "Hello, Ada"}` {
		t.Errorf("greet's request %s, response %s", greet.Request, greet.Response)
	}
}

func TestStart_Refusals(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	r := newRunner(t, Options{})
	w := saveWorkflow(t, "http://x.example", greetDef)
	broken := saveWorkflow(t, "", `{"nodes": [{"id": "a", "kind": "transform", "expr": "("}]}`)

	var invalid *InvalidError
	if _, err := r.Start(ctx, broken.ID, 0, nil); !errors.As(err, &invalid) || invalid.Revision != 1 || len(invalid.Problems) == 0 ||
		err.Error() != "revision 1 has problems" {
		t.Errorf("a revision with problems: %v", err)
	}
	var input *InputError
	if _, err := r.Start(ctx, w.ID, 0, json.RawMessage(`{"user_id": 7}`)); !errors.As(err, &input) ||
		len(input.Problems) != 1 || input.Problems[0].Pointer != "/user_id" || input.Problems[0].Code != "invalid_input" ||
		err.Error() != "the input doesn't match the input schema" {
		t.Errorf("input the schema refuses: %v", err)
	}
	if _, err := r.Start(ctx, w.ID, 0, nil); !errors.As(err, &input) || input.Problems[0].Pointer != "" {
		t.Errorf("no input, which is null: %v", err)
	}
	if _, err := r.Start(ctx, w.ID, 0, json.RawMessage(`{`)); !errors.As(err, &input) || input.Problems[0].Code != "invalid_json" {
		t.Errorf("input that isn't JSON: %v", err)
	}
	if _, err := r.Start(ctx, w.ID, 2, nil); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("a revision that doesn't exist: %v", err)
	}
	if _, err := r.Start(ctx, "01890000-0000-7000-8000-000000000000", 0, nil); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("a workflow that doesn't exist: %v", err)
	}
}

func TestServe(t *testing.T) {
	t.Parallel()
	big := `"` + strings.Repeat("x", maxStored) + `"`
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ok", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"n": 1}`) })
	mux.HandleFunc("GET /fail", func(w http.ResponseWriter, r *http.Request) { http.Error(w, `{"error": "down"}`, 500) })
	mux.HandleFunc("GET /slow", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	})
	mux.HandleFunc("GET /big", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, big) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	r := newRunner(t, Options{ServedTimeout: time.Second})

	call := func(path, extra, output string) string {
		return fmt.Sprintf(`{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE%s"%s}}], "output": %q}`, path, extra, output)
	}
	// picks answers through a transform that picks among 200 and 201.
	picks := func(expr string) string {
		return `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/ok"}}, {"id": "r", "kind": "transform", "expr": "` + expr + `"}],
		  "edges": [{"from": "a", "to": "r"}], "response": {"answers": [{"status": 200, "lines": [{"from": "r"}]}, {"status": 201, "lines": [{"from": "r"}]}]}}`
	}
	// unhandled answers a's failure with the body given.
	unhandled := func(body string) string {
		return `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/fail"}}],
		  "response": {"answers": [{"status": 200, "lines": [{"from": "a"}]}], "errors": {"body": "` + body + `"}}}`
	}
	tests := []struct {
		name, def    string
		status, code string
		node         string
		answer       int
		output       string // the answer's body in full
	}{
		{"succeeds", call("/ok", "", "nodes.a.body.n + 1"), "succeeded", "", "", 200, "2"},
		{"an upstream fails", call("/fail", "", "1"), "failed", CodeUpstream, "a", 0, ""},
		{"an attempt times out", call("/slow", `, "timeout_ms": 50`, "1"), "failed", CodeTimeout, "a", 0, ""},
		{"the run times out", call("/slow", "", "1"), "failed", CodeTimeout, "", 0, ""},
		{"an expression fails", call("/ok", "", "$number('one')"), "failed", CodeWorkflow, "", 0, ""},
		{"the output is kept in full but stored capped", call("/big", "", "nodes.a.body"), "succeeded", "", "", 200, big},
		{"it answers through its response", picks("{ 'status': 201, 'body': nodes.a.body.n }"), "succeeded", "", "", 201, "1"},
		{"an answer with no body", picks("{ 'status': 200 }"), "succeeded", "", "", 200, ""},
		{"no answer it gives", picks("{ 'status': 404 }"), "failed", CodeWorkflow, "", 0, ""},
		{
			"unhandled answers a failure, with its cause's status", unhandled("{ 'error': error.code, 'at': error.node }"),
			"failed", CodeUpstream, "a", 502, `{"error":"upstream_failed","at":"a"}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			w := saveWorkflow(t, srv.URL, tt.def)
			out, err := r.Serve(t.Context(), w.Slug, nil)
			if err != nil {
				t.Fatal(err)
			}
			if out.Run.Status != tt.status || out.Run.Trigger != "served" || out.Run.EndedAt == nil {
				t.Errorf("run = %+v", out.Run)
			}
			if out.Answer != tt.answer || string(out.Output) != tt.output {
				t.Errorf("answer %d %.40s; want %d %.40s", out.Answer, out.Output, tt.answer, tt.output)
			}
			if tt.code == "" {
				if out.Failure != nil {
					t.Errorf("failure %+v", out.Failure)
				}
			} else if out.Failure == nil || out.Failure.Code != tt.code || out.Failure.Node != tt.node {
				t.Errorf("failure = %+v; want code %s on node %q", out.Failure, tt.code, tt.node)
			}
			stored, err := db.Run(t.Context(), out.Run.ID)
			if err != nil || stored.Status != tt.status || stored.Answered != tt.answer || out.Run.Answered != tt.answer {
				t.Fatalf("stored run = %+v, %v; returned answered %d", stored, err, out.Run.Answered)
			}
			if tt.code != "" {
				if f := decode[Failure](t, stored.Error); f != *out.Failure {
					t.Errorf("stored failure %+v, returned %+v", f, *out.Failure)
				}
			}
			if len(tt.output) > maxStored {
				if preview := decode[string](t, stored.Output); !stored.OutputTruncated || len(preview) != maxStored {
					t.Errorf("stored output: a %d-byte preview, truncated %v", len(preview), stored.OutputTruncated)
				}
			}
		})
	}
}

// An error body that fails leaves the run's failure to answer, and says why.
func TestServe_AnErrorBodyThatFails(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error": "down"}`, http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	r := newRunner(t, Options{})
	w := saveWorkflow(t, srv.URL, `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/"}}],
	  "response": {"answers": [{"status": 200, "lines": [{"from": "a"}]}], "errors": {"body": "$number(error.code)"}}}`)
	out, err := r.Serve(t.Context(), w.Slug, nil)
	if err != nil {
		t.Fatal(err)
	}
	if out.Answer != 0 || out.Output != nil || out.Failure == nil || out.Failure.Code != CodeUpstream ||
		!strings.Contains(out.Failure.Detail, "; the error body failed too: error body: ") {
		t.Errorf("answer %d %s, failure %+v", out.Answer, out.Output, out.Failure)
	}
	if stored, err := db.Run(t.Context(), out.Run.ID); err != nil || stored.Answered != 0 || decode[Failure](t, stored.Error) != *out.Failure {
		t.Errorf("stored run = %+v, %v", stored, err)
	}
}

// An answer that passes an error on whose error body fails answers
// problem details instead, which say the body failed too.
func TestServe_AnErrorAnswerWhoseBodyFails(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `{"error": "gone"}`)
	}))
	t.Cleanup(srv.Close)
	r := newRunner(t, Options{})
	w := saveWorkflow(t, srv.URL, `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/"}, "outputs": [{"status": 404}]}],
	  "response": {"answers": [{"status": 200, "lines": [{"from": "a"}]}, {"status": 404, "lines": [{"from": "a", "on": 404}]}], "errors": {"body": "$number(error.code)"}}}`)
	out, err := r.Serve(t.Context(), w.Slug, nil)
	if err != nil {
		t.Fatal(err)
	}
	if out.Answer != 404 || out.Output != nil || out.Problem == nil || out.Problem.Code != CodeUpstream || out.Problem.Node != "a" ||
		!strings.HasPrefix(out.Problem.Detail, "a answered 404; the error body failed too: error body: ") {
		t.Errorf("answer %d %s, problem %+v", out.Answer, out.Output, out.Problem)
	}
}

// An answer that passes an error on, from an error block or from an
// Unhandled with no body of its own, answers the response's error body over
// that error, or, with none, Conduit's problem details (plan 12). A body of
// the step's own still answers as written.
func TestServe_ErrorAnswers(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /gone", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Trace", "t-1")
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `{"error": "gone"}`)
	})
	mux.HandleFunc("GET /fail", func(w http.ResponseWriter, r *http.Request) { http.Error(w, `{"error": "down"}`, 500) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	r := newRunner(t, Options{})

	gone := func(errors string) string {
		return `{"nodes": [{"id": "user", "kind": "http", "request": {"method": "GET", "url": "BASE/gone"}, "outputs": [{"status": 404}]}],
		  "response": {"answers": [{"status": 200, "lines": [{"from": "user"}]}, {"status": 404, "lines": [{"from": "user", "on": 404}]}]` + errors + `}}`
	}
	down := func(unhandled, errors string) string {
		return `{"nodes": [{"id": "user", "kind": "http", "request": {"method": "GET", "url": "BASE/fail"}` + unhandled + `}],
		  "response": {"answers": [{"status": 200, "lines": [{"from": "user"}]}, {"status": 502, "lines": [{"from": "user", "unhandled": true}]}]` + errors + `}}`
	}
	shape := `, "errors": {"body": "{ 'error': error.code, 'why': error.detail, 'at': error.node, 'got': error.status, 'said': error.body.error, 'trace': error.headers.'x-trace' }"}`
	failed := fmt.Sprintf("GET %s/fail: status 500", srv.URL)
	tests := []struct {
		name, def string
		answer    int
		output    string
		problem   *Failure
	}{
		{
			"an error block, with an error body", gone(shape), 404,
			`{"error":"upstream_failed","why":"user answered 404","at":"user","got":404,"said":"gone","trace":"t-1"}`, nil,
		},
		{"an error block, with none", gone(""), 404, "", &Failure{Code: CodeUpstream, Detail: "user answered 404", Node: "user"}},
		{
			"an Unhandled, with an error body", down("", shape), 502,
			`{"error":"upstream_failed","why":"` + failed + `","at":"user","got":500,"said":"down"}`, nil,
		},
		{"an Unhandled, with none", down("", ""), 502, "", &Failure{Code: CodeUpstream, Detail: failed, Node: "user"}},
		{"an Unhandled body of its own", down(`, "unhandled": {"body": "{ 'down': true }"}`, shape), 502, `{"down":true}`, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			w := saveWorkflow(t, srv.URL, tt.def)
			out, err := r.Serve(t.Context(), w.Slug, nil)
			if err != nil {
				t.Fatal(err)
			}
			if out.Run.Status != "succeeded" || out.Answer != tt.answer || string(out.Output) != tt.output || out.Failure != nil {
				t.Errorf("run %s answered %d %s, failure %+v; want %d %s", out.Run.Status, out.Answer, out.Output, out.Failure, tt.answer, tt.output)
			}
			if (out.Problem == nil) != (tt.problem == nil) || out.Problem != nil && *out.Problem != *tt.problem {
				t.Errorf("problem %+v, want %+v", out.Problem, tt.problem)
			}
			if stored, err := db.Run(t.Context(), out.Run.ID); err != nil || stored.Answered != tt.answer {
				t.Errorf("stored run = %+v, %v", stored, err)
			}
		})
	}
}

// What a transform's Unhandled body gave is recorded, though the transform
// gave no value of its own.
func TestServe_ATransformsUnhandledBodyIsRecorded(t *testing.T) {
	t.Parallel()
	r := newRunner(t, Options{})
	w := saveWorkflow(t, "", `{"nodes": [{"id": "count", "kind": "transform", "expr": "$number('two')", "unhandled": {"body": "0"}},
	    {"id": "next", "kind": "transform", "expr": "nodes.count.body + 1"}],
	  "edges": [{"from": "count", "to": "next", "unhandled": true}],
	  "response": {"answers": [{"status": 200, "lines": [{"from": "next"}]}]}}`)
	out, err := r.Serve(t.Context(), w.Slug, nil)
	if err != nil {
		t.Fatal(err)
	}
	if out.Answer != 200 || string(out.Output) != "1" {
		t.Errorf("answered %d %s, failure %+v", out.Answer, out.Output, out.Failure)
	}
	nodes, err := db.NodeRuns(t.Context(), out.Run.ID)
	if err != nil || len(nodes) != 2 {
		t.Fatalf("NodeRuns() = %+v, %v", nodes, err)
	}
	if got := decode[responseDoc](t, nodes[0].Response); string(got.Gave) != "0" || string(got.Body) != "null" {
		t.Errorf("count's response = %s", nodes[0].Response)
	}
}

// A transform's case is recorded as an http node's answer is: its status
// and its body.
func TestServe_ACasesStatusIsRecorded(t *testing.T) {
	t.Parallel()
	r := newRunner(t, Options{})
	w := saveWorkflow(t, "", `{"nodes": [{"id": "check", "kind": "transform",
	    "switch": {"cases": [{"when": "input.id = 0", "status": 404, "body": "{ 'error': 'gone' }"}, {"when": "true", "status": 200}]}}],
	  "response": {"answers": [{"status": 200, "lines": [{"from": "check", "on": 200}]}, {"status": 404, "lines": [{"from": "check", "on": 404}]}]}}`)
	out, err := r.Serve(t.Context(), w.Slug, json.RawMessage(`{"id": 0}`))
	if err != nil || out.Answer != 404 || string(out.Output) != `{"error":"gone"}` {
		t.Fatalf("Serve() = %d %s, %v", out.Answer, out.Output, err)
	}
	nodes, err := db.NodeRuns(t.Context(), out.Run.ID)
	if err != nil || len(nodes) != 1 {
		t.Fatalf("NodeRuns() = %+v, %v", nodes, err)
	}
	got := decode[responseDoc](t, nodes[0].Response)
	if body := decode[map[string]string](t, got.Body); got.Status != 404 || body["error"] != "gone" || got.Headers != nil {
		t.Errorf("check's response = %s", nodes[0].Response)
	}
}

// Each node is recorded with the lines its answer took, as the definition
// writes those edges: from its value, or from its Unhandled; one with no
// line out of it has none.
func TestServe_TheLinesTakenAreRecorded(t *testing.T) {
	t.Parallel()
	r := newRunner(t, Options{})
	w := saveWorkflow(t, "", `{"nodes": [{"id": "count", "kind": "transform", "expr": "$number(input.n)"},
	    {"id": "e", "kind": "transform", "expr": "$exists(nodes.count.error) ? 0 : nodes.count.body"}],
	  "edges": [{"from": "count", "to": "e"}, {"from": "count", "to": "e", "unhandled": true}],
	  "response": {"answers": [{"status": 200, "lines": [{"from": "e"}]}]}}`)
	for input, want := range map[string]struct {
		output string
		took   []Line
	}{
		`{"n": "2"}`:   {"2", []Line{{To: "e"}}},
		`{"n": "two"}`: {"0", []Line{{To: "e", Unhandled: true}}},
	} {
		out, err := r.Serve(t.Context(), w.Slug, json.RawMessage(input))
		if err != nil {
			t.Fatal(err)
		}
		if out.Answer != 200 || string(out.Output) != want.output {
			t.Errorf("%s: answered %d %s, failure %+v", input, out.Answer, out.Output, out.Failure)
		}
		nodes, err := db.NodeRuns(t.Context(), out.Run.ID)
		if err != nil || len(nodes) != 2 {
			t.Fatalf("%s: NodeRuns() = %+v, %v", input, nodes, err)
		}
		if !slices.Equal(decode[[]Line](t, nodes[0].Took), want.took) || nodes[1].Took != nil {
			t.Errorf("%s: count took %s, e %s", input, nodes[0].Took, nodes[1].Took)
		}
	}
}

// A step's Unhandled block takes its failure: the step is recorded failed
// and caught, and the run answers through the steps after the block.
func TestServe_AStepsUnhandledTakesItsFailure(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error": "down"}`, http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	r := newRunner(t, Options{})
	w := saveWorkflow(t, srv.URL, `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/"}, "unhandled": {"body": "{ 'down': true }"}},
	    {"id": "sorry", "kind": "transform", "expr": "{ 'error': nodes.a.error.code, 'upstream': nodes.a.status }"}],
	  "edges": [{"from": "a", "to": "sorry", "unhandled": true}],
	  "response": {"answers": [{"status": 200, "lines": [{"from": "a"}]}, {"status": 503, "lines": [{"from": "sorry"}]}]}}`)
	out, err := r.Serve(t.Context(), w.Slug, nil)
	if err != nil {
		t.Fatal(err)
	}
	if out.Run.Status != "succeeded" || out.Answer != 503 || string(out.Output) != `{"error":"upstream_failed","upstream":500}` || out.Failure != nil {
		t.Errorf("run %s answered %d %s, failure %+v", out.Run.Status, out.Answer, out.Output, out.Failure)
	}
	nodes, err := db.NodeRuns(t.Context(), out.Run.ID)
	if err != nil || len(nodes) != 2 {
		t.Fatalf("NodeRuns() = %+v, %v", nodes, err)
	}
	if a, f := nodes[0], decode[Failure](t, nodes[0].Error); a.Status != "failed" || f.Code != CodeUpstream || !f.Caught {
		t.Errorf("a = %s, error %s", a.Status, a.Error)
	}
	// What it got is kept, and what its Unhandled body gave beside it.
	if got := decode[responseDoc](t, nodes[0].Response); got.Status != 500 || string(got.Gave) != `{"down": true}` { // as jsonb writes it
		t.Errorf("a's response = %s", nodes[0].Response)
	}
	if sorry := nodes[1]; sorry.Status != "succeeded" || sorry.Error != nil {
		t.Errorf("sorry = %s, error %s", sorry.Status, sorry.Error)
	}
}

func TestServe_Refusals(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	r := newRunner(t, Options{})
	if _, err := r.Serve(ctx, "no-such-slug", nil); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("an unknown slug: %v", err)
	}
	w, _, err := db.CreateWorkflow(ctx, slug(t), "test", json.RawMessage(`{"nodes": []}`), store.Provenance{Actor: "token"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Serve(ctx, w.Slug, nil); !errors.Is(err, ErrNotPublished) {
		t.Errorf("a workflow never published: %v", err)
	}
}

func TestServe_APanicIsOurBugAndOnlyTheLogSaysMore(t *testing.T) {
	t.Parallel()
	var logged strings.Builder
	log := slog.New(slog.NewTextHandler(&lockedWriter{w: &logged}, nil))
	// A nil client panics the moment an http node calls it.
	r := New(db, nil, log, Options{})
	t.Cleanup(r.Stop)
	w := saveWorkflow(t, "http://x.example", holdDef)

	out, err := r.Serve(t.Context(), w.Slug, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := Failure{Code: CodeInternal, Detail: internalDetail, Node: "a"}
	if out.Failure == nil || *out.Failure != want {
		t.Errorf("failure = %+v, want %+v", out.Failure, want)
	}
	if s := logged.String(); strings.Count(s, "a run panicked") != 1 || !strings.Contains(s, "goroutine") {
		t.Errorf("want the panic logged once, with its stack; log:\n%s", s)
	}
}

// lockedWriter lets a log written from several goroutines be read after.
type lockedWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

// hold is an upstream that answers once released, or once its caller gives
// up. arrived gets a value as each request comes in.
type hold struct {
	srv     *httptest.Server
	arrived chan struct{}
	release chan struct{}
}

func newHold(t *testing.T) *hold {
	t.Helper()
	h := &hold{arrived: make(chan struct{}, 10), release: make(chan struct{})}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.arrived <- struct{}{}
		select {
		case <-h.release:
			fmt.Fprint(w, `{}`)
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(h.srv.Close)
	return h
}

func (h *hold) wait(t *testing.T) {
	t.Helper()
	select {
	case <-h.arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("the upstream never got the request")
	}
}

const holdDef = `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/"}}]}`

func TestServe_ACallerWhoHangsUpCancelsTheRun(t *testing.T) {
	t.Parallel()
	h := newHold(t)
	r := newRunner(t, Options{})
	w := saveWorkflow(t, h.srv.URL, holdDef)

	ctx, hangUp := context.WithCancel(t.Context())
	done := make(chan Outcome, 1)
	go func() {
		out, err := r.Serve(ctx, w.Slug, nil)
		if err != nil {
			t.Error(err)
		}
		done <- out
	}()
	h.wait(t)
	hangUp()
	out := <-done
	if out.Run.Status != "cancelled" || out.Failure == nil || out.Failure.Code != CodeCancelled || out.Failure.Detail != ErrCallerGone.Error() {
		t.Errorf("run %+v, failure %+v", out.Run, out.Failure)
	}
	nodes, err := db.NodeRuns(t.Context(), out.Run.ID)
	if err != nil || len(nodes) != 1 || nodes[0].Status != "cancelled" || nodes[0].Error != nil {
		t.Errorf("nodes = %+v, %v", nodes, err)
	}
}

func TestStart_RefusedAtTheCap(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	h := newHold(t)
	r := newRunner(t, Options{MaxRuns: 1})
	w := saveWorkflow(t, h.srv.URL, holdDef)

	first, err := r.Start(ctx, w.ID, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.wait(t)
	if _, err := r.Start(ctx, w.ID, 0, nil); !errors.Is(err, ErrBusy) {
		t.Errorf("a second editor run: %v, want ErrBusy", err)
	}
	if _, err := r.Serve(ctx, w.Slug, nil); !errors.Is(err, ErrBusy) {
		t.Errorf("a served run: %v, want ErrBusy", err)
	}
	// Another workflow's run, refused at the server's cap, isn't counted
	// against its own share.
	other := saveWorkflow(t, h.srv.URL, holdDef)
	if _, err := r.Serve(ctx, other.Slug, nil); !errors.Is(err, ErrBusy) || errors.Is(err, ErrWorkflowBusy) {
		t.Errorf("another workflow's run: %v, want the server's ErrBusy", err)
	}
	close(h.release)
	if got := seqs(collect(t, r, first.ID)); got != "1 a started, 2 a succeeded, end run succeeded" {
		t.Errorf("first run = %s", got)
	}
	if _, err := r.Serve(ctx, w.Slug, nil); err != nil {
		t.Errorf("once the first run ended: %v", err)
	}
	if _, err := r.Serve(ctx, other.Slug, nil); err != nil {
		t.Errorf("the other workflow, once the first run ended: %v", err)
	}
}

// A workflow may have a quarter of the slots at once, so a loop through an
// API that drops the trace holds that workflow's runs and leaves the rest
// to the others (plan 06).
func TestStart_AWorkflowHasAQuarterOfTheSlots(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	h := newHold(t)
	quick := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{}`) }))
	t.Cleanup(quick.Close)
	r := newRunner(t, Options{MaxRuns: 8})
	w := saveWorkflow(t, h.srv.URL, holdDef)

	var held []store.Run
	for range 2 {
		run, err := r.Start(ctx, w.ID, 0, nil)
		if err != nil {
			t.Fatal(err)
		}
		h.wait(t)
		held = append(held, run)
	}
	if _, err := r.Serve(ctx, w.Slug, nil); !errors.Is(err, ErrWorkflowBusy) || !errors.Is(err, ErrBusy) {
		t.Errorf("a third run of the workflow: %v, want ErrWorkflowBusy, a kind of ErrBusy", err)
	}
	if _, err := r.Serve(ctx, saveWorkflow(t, quick.URL, holdDef).Slug, nil); err != nil {
		t.Errorf("another workflow meanwhile: %v", err)
	}
	close(h.release)
	for _, run := range held {
		collect(t, r, run.ID)
	}
	if _, err := r.Serve(ctx, w.Slug, nil); err != nil {
		t.Errorf("once its runs ended: %v", err)
	}
}

// A run continues its caller's trace, or starts one, records it, and its
// calls pass it on one hop further. A call that has passed through Conduit
// trace.MaxHops times is refused before a run starts: a workflow calling
// itself, round and round (plan 06).
func TestStart_Traces(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	var got http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		fmt.Fprint(w, `{}`)
	}))
	t.Cleanup(srv.Close)
	r := newRunner(t, Options{})
	w := saveWorkflow(t, srv.URL, holdDef)
	const id = "4bf92f3577b34da6a3ce929d0e0e4736"
	at := func(hops int) context.Context {
		return trace.With(ctx, trace.Read(http.Header{
			"Traceparent": {"00-" + id + "-00f067aa0ba902b7-01"},
			"Tracestate":  {fmt.Sprintf("conduit=h:%d", hops)},
		}))
	}

	if _, err := r.Start(at(trace.MaxHops), w.ID, 0, nil); !errors.Is(err, ErrLoop) {
		t.Errorf("an editor run %d hops in: %v, want ErrLoop", trace.MaxHops, err)
	}
	if _, err := r.Serve(at(trace.MaxHops), w.Slug, nil); !errors.Is(err, ErrLoop) {
		t.Errorf("a served run %d hops in: %v, want ErrLoop", trace.MaxHops, err)
	}
	out, err := r.Serve(at(trace.MaxHops-1), w.Slug, nil)
	if err != nil {
		t.Fatal(err)
	}
	if out.Run.TraceID != id || !strings.HasPrefix(got.Get("Traceparent"), "00-"+id+"-") ||
		got.Get("Tracestate") != fmt.Sprintf("conduit=h:%d", trace.MaxHops) {
		t.Errorf("one hop fewer: recorded trace %q, called with traceparent %q and tracestate %q",
			out.Run.TraceID, got.Get("Traceparent"), got.Get("Tracestate"))
	}

	ran, err := r.Start(ctx, w.ID, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	collect(t, r, ran.ID)
	if len(ran.TraceID) != 32 || ran.TraceID == id || !strings.HasPrefix(got.Get("Traceparent"), "00-"+ran.TraceID+"-") ||
		got.Get("Tracestate") != "conduit=h:1" {
		t.Errorf("no trace: recorded %q, called with traceparent %q and tracestate %q",
			ran.TraceID, got.Get("Traceparent"), got.Get("Tracestate"))
	}
}

// A run is of its revision filled from the upstreams its nodes use (plan
// 07), so one that uses a version the library doesn't have isn't run.
func TestStart_AnUpstreamTheLibraryDoesntHave(t *testing.T) {
	t.Parallel()
	r := newRunner(t, Options{})
	w := saveWorkflow(t, "", `{"nodes": [{"id": "a", "kind": "http", "uses": {"upstream": "no-such", "version": 1}}]}`)
	_, err := r.Start(t.Context(), w.ID, 0, nil)
	var invalid *InvalidError
	if !errors.As(err, &invalid) || len(invalid.Problems) != 1 || invalid.Problems[0].Code != "unknown_upstream" {
		t.Errorf("Start() = %v, want unknown_upstream", err)
	}
}

func TestStop_CancelsEditorRunsAndWaitsForThem(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	h := newHold(t)
	// Not newRunner: this test stops and waits itself.
	r := New(db, upstream.New(upstream.Options{AllowPrivateNetworks: true}), slog.New(slog.DiscardHandler), Options{})
	w := saveWorkflow(t, h.srv.URL, holdDef)

	run, err := r.Start(ctx, w.ID, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.wait(t)
	r.Stop()
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := r.Wait(waitCtx); err != nil {
		t.Fatal(err)
	}
	stored, err := db.Run(ctx, run.ID)
	if err != nil || stored.Status != "cancelled" || decode[Failure](t, stored.Error).Detail != ErrStopped.Error() {
		t.Errorf("stored run = %+v (%s), %v", stored, stored.Error, err)
	}
	if _, err := r.Start(ctx, w.ID, 0, nil); !errors.Is(err, ErrBusy) {
		t.Errorf("a run after Stop: %v, want ErrBusy", err)
	}
}

func TestWatch(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	r := newRunner(t, Options{})
	w := saveWorkflow(t, greetUpstream(t).URL, greetDef)
	run, err := r.Start(ctx, w.ID, 0, json.RawMessage(`{"user_id": "7"}`))
	if err != nil {
		t.Fatal(err)
	}
	collect(t, r, run.ID)

	// Ended, with its log still in memory: the node events after the
	// position at once, then the run's own, from the database.
	from := func(after int) string {
		t.Helper()
		w, err := r.Watch(ctx, run.ID, after)
		if err != nil {
			t.Fatal(err)
		}
		return seqs(rest(t, ctx, w))
	}
	if got := from(3); got != "4 greet succeeded, end run succeeded" {
		t.Errorf("after 3: %s", got)
	}
	if got := from(4); got != "end run succeeded" {
		t.Errorf("after the last node event: %s", got)
	}
	// Once the log is gone, only the run's event.
	r.events.mu.Lock()
	delete(r.events.logs, run.ID)
	r.events.mu.Unlock()
	if got := from(0); got != "end run succeeded" {
		t.Errorf("once the log is gone: %s", got)
	}
	// The run's event comes from the database, whose errors Next passes on.
	watch, err := r.Watch(ctx, run.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := watch.Next(cancelled); !errors.Is(err, context.Canceled) {
		t.Errorf("Next with a cancelled context: %v", err)
	}

	if _, err := r.Watch(ctx, "01890000-0000-7000-8000-000000000000", 0); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("an unknown run: %v", err)
	}
	other, err := db.StartRun(ctx, w.ID, 1, "editor", "4bf92f3577b34da6a3ce929d0e0e4736", json.RawMessage(`null`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Watch(ctx, other.ID, 0); !errors.Is(err, ErrNotHere) {
		t.Errorf("a running run this process didn't start: %v", err)
	}
}

func TestWatch_WaitsForTheRunToGoOn(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	h := newHold(t)
	r := newRunner(t, Options{})
	w := saveWorkflow(t, h.srv.URL, holdDef)
	run, err := r.Start(ctx, w.ID, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.wait(t)
	watch, err := r.Watch(ctx, run.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if events, err := watch.Next(ctx); err != nil || seqs(events) != "1 a started" {
		t.Fatalf("first Next = %s, %v", seqs(events), err)
	}
	// Nothing more happens while the upstream holds, so Next waits until
	// its context is done.
	short, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if events, err := watch.Next(short); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("Next while nothing happens = %s, %v; want it to wait", seqs(events), err)
	}
	close(h.release)
	if got := seqs(rest(t, ctx, watch)); got != "2 a succeeded, end run succeeded" {
		t.Errorf("the rest = %s", got)
	}
}

// Not parallel: it fails every running run in the database, and parallel
// tests only start once the sequential ones are done.
func TestRecover(t *testing.T) {
	ctx := t.Context()
	r := newRunner(t, Options{})
	w := saveWorkflow(t, "", `{"nodes": []}`)
	left, err := db.StartRun(ctx, w.ID, 1, "served", "4bf92f3577b34da6a3ce929d0e0e4736", json.RawMessage(`null`))
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	stored, err := db.Run(ctx, left.ID)
	if err != nil || stored.Status != "failed" || decode[Failure](t, stored.Error).Code != "interrupted" {
		t.Errorf("a run left running = %+v (%s), %v", stored, stored.Error, err)
	}
}
