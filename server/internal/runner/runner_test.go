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
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/store/storetest"
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

// collect watches a run from the start until its last event.
func collect(t *testing.T, r *Runner, runID string) []Event {
	t.Helper()
	w, err := r.Watch(t.Context(), runID, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	events := w.Events
	if w.Live == nil {
		return events
	}
	timeout := time.After(10 * time.Second)
	for {
		select {
		case e, ok := <-w.Live:
			if !ok {
				return events
			}
			events = append(events, e)
		case <-timeout:
			t.Fatalf("no run event; got %s", seqs(events))
		}
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
	if got, want := seqs(events), "1 user started, 2 user succeeded, 3 greet started, 4 greet succeeded, 5 run succeeded"; got != want {
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
	tests := []struct {
		name, def    string
		status, code string
		node         string
		output       string // the output in full
	}{
		{"succeeds", call("/ok", "", "nodes.a.body.n + 1"), "succeeded", "", "", "2"},
		{"an upstream fails", call("/fail", "", "1"), "failed", CodeUpstream, "a", ""},
		{"an attempt times out", call("/slow", `, "timeout_ms": 50`, "1"), "failed", CodeTimeout, "a", ""},
		{"the run times out", call("/slow", "", "1"), "failed", CodeTimeout, "", ""},
		{"an expression fails", call("/ok", "", "$number('one')"), "failed", CodeWorkflow, "", ""},
		{"the output is kept in full but stored capped", call("/big", "", "nodes.a.body"), "succeeded", "", "", big},
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
			if tt.code == "" {
				if out.Failure != nil || string(out.Output) != tt.output {
					t.Errorf("failure %+v, output %.40s; want output %.40s", out.Failure, out.Output, tt.output)
				}
			} else if out.Failure == nil || out.Failure.Code != tt.code || out.Failure.Node != tt.node {
				t.Errorf("failure = %+v, want code %s on node %q", out.Failure, tt.code, tt.node)
			}
			stored, err := db.Run(t.Context(), out.Run.ID)
			if err != nil || stored.Status != tt.status {
				t.Fatalf("stored run = %+v, %v", stored, err)
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
	close(h.release)
	if got := seqs(collect(t, r, first.ID)); got != "1 a started, 2 a succeeded, 3 run succeeded" {
		t.Errorf("first run = %s", got)
	}
	if _, err := r.Serve(ctx, w.Slug, nil); err != nil {
		t.Errorf("once the first run ended: %v", err)
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

	// Ended, with its log still in memory: the node events after the one
	// named, then the run's own from the database.
	watch, err := r.Watch(ctx, run.ID, 3)
	if err != nil || watch.Live != nil || seqs(watch.Events) != "4 greet succeeded, 5 run succeeded" {
		t.Errorf("watch after 3 = %+v, %v", watch, err)
	}
	if watch, err := r.Watch(ctx, run.ID, 5); err != nil || len(watch.Events) != 0 {
		t.Errorf("watch after the last event = %+v, %v", watch, err)
	}
	// Once the log is gone, only the run's event, without a number.
	r.events.mu.Lock()
	delete(r.events.logs, run.ID)
	r.events.mu.Unlock()
	if watch, err := r.Watch(ctx, run.ID, 0); err != nil || seqs(watch.Events) != "0 run succeeded" {
		t.Errorf("watch once the log is gone = %+v, %v", watch, err)
	}

	if _, err := r.Watch(ctx, "01890000-0000-7000-8000-000000000000", 0); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("an unknown run: %v", err)
	}
	other, err := db.StartRun(ctx, w.ID, 1, "editor", json.RawMessage(`null`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Watch(ctx, other.ID, 0); !errors.Is(err, ErrNotHere) {
		t.Errorf("a running run this process didn't start: %v", err)
	}
}

// Not parallel: it fails every running run in the database, and parallel
// tests only start once the sequential ones are done.
func TestRecover(t *testing.T) {
	ctx := t.Context()
	r := newRunner(t, Options{})
	w := saveWorkflow(t, "", `{"nodes": []}`)
	left, err := db.StartRun(ctx, w.ID, 1, "served", json.RawMessage(`null`))
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
