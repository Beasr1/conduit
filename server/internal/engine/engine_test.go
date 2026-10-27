package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Beasr1/conduit/server/internal/transform"
	"github.com/Beasr1/conduit/server/internal/upstream"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// program compiles a definition written as JSON, with BASE standing for a
// test server's URL.
func program(t *testing.T, base, def string) *Program {
	t.Helper()
	var d workflow.Definition
	if err := json.Unmarshal([]byte(strings.ReplaceAll(def, "BASE", base)), &d); err != nil {
		t.Fatalf("decode definition: %v", err)
	}
	p, err := Compile(&d)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	return p
}

// testEngine reaches httptest servers, which listen on loopback.
func testEngine(o Options) *Engine {
	return New(upstream.New(upstream.Options{AllowPrivateNetworks: true}), o)
}

// recorder collects events. Run calls it from one goroutine and returns
// after the last call, so it needs no lock.
type recorder struct{ events []Event }

func (r *recorder) record(e Event) { r.events = append(r.events, e) }

// list renders the events as "node kind" lines, optionally only some kinds.
func (r *recorder) list(kinds ...EventKind) string {
	var out []string
	for _, e := range r.events {
		if len(kinds) == 0 || slices.Contains(kinds, e.Kind) {
			out = append(out, e.Node+" "+string(e.Kind))
		}
	}
	return strings.Join(out, ", ")
}

func statuses(res *Result) string {
	var out []string
	for _, n := range res.Nodes {
		out = append(out, n.ID+" "+string(n.Status))
	}
	return strings.Join(out, ", ")
}

func execute(t *testing.T, e *Engine, p *Program, input string) (*Result, *recorder) {
	t.Helper()
	rec := &recorder{}
	res, err := e.Run(t.Context(), p, "run-1", json.RawMessage(input), rec.record)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	return res, rec
}

const specExample = `{
  "nodes": [
    {"id": "user", "kind": "http",
     "request": {"method": "GET", "url": "BASE/v1/users/{{ input.user_id }}"}},
    {"id": "orders", "kind": "http",
     "request": {"method": "GET", "url": "BASE/v1/orders?user={{ nodes.user.body.id }}"}},
    {"id": "prefs", "kind": "http",
     "request": {"method": "GET", "url": "BASE/v1/prefs/{{ nodes.user.body.id }}"}},
    {"id": "crm", "kind": "http",
     "request": {"method": "POST", "url": "BASE/v1/contacts",
                 "body": "{ 'email': nodes.user.body.email, 'orders': $count(nodes.orders.body.items), 'channel': nodes.prefs.body.channel }"}}
  ],
  "edges": [
    {"from": "user", "to": "orders"},
    {"from": "user", "to": "prefs"},
    {"from": "orders", "to": "crm"},
    {"from": "prefs", "to": "crm"}
  ],
  "output": "{ 'crm_id': nodes.crm.body.id, 'user': nodes.user.body.id }"
}`

func TestRun_SpecExample(t *testing.T) {
	t.Parallel()
	// orders and prefs each wait for the other, so the run only succeeds if
	// they're in flight at the same time.
	var arrived sync.WaitGroup
	arrived.Add(2)
	together := func() bool {
		arrived.Done()
		done := make(chan struct{})
		go func() { arrived.Wait(); close(done) }()
		select {
		case <-done:
			return true
		case <-time.After(5 * time.Second):
			return false
		}
	}
	crmBody := make(chan string, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/users/u-42", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"id": 12345678901234567890, "email": "ada@example.com"}`)
	})
	mux.HandleFunc("GET /v1/orders", func(w http.ResponseWriter, r *http.Request) {
		if !together() || r.URL.Query().Get("user") != "12345678901234567890" {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		fmt.Fprint(w, `{"items": [{"sku": "a"}, {"sku": "b"}]}`)
	})
	mux.HandleFunc("GET /v1/prefs/12345678901234567890", func(w http.ResponseWriter, r *http.Request) {
		if !together() {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		fmt.Fprint(w, `{"channel": "email"}`)
	})
	mux.HandleFunc("POST /v1/contacts", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		crmBody <- string(b)
		w.WriteHeader(http.StatusCreated)
		fmt.Fprint(w, `{"id": "c-1"}`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	p := program(t, srv.URL, specExample)
	if n := p.NodeCount(); n != 4 {
		t.Errorf("NodeCount() = %d, want 4", n)
	}
	res, rec := execute(t, testEngine(Options{}), p, `{"user_id": "u-42"}`)
	if res.Status != StatusSucceeded {
		t.Fatalf("run %s: %v (%s)", res.Status, res.Err, statuses(res))
	}
	if got, want := string(res.Output), `{"crm_id":"c-1","user":12345678901234567890}`; got != want {
		t.Errorf("output = %s, want %s", got, want)
	}
	if got, want := <-crmBody, `{"email":"ada@example.com","orders":2,"channel":"email"}`; got != want {
		t.Errorf("crm got %s, want %s", got, want)
	}
	if got, want := rec.list(), "user started, user succeeded, orders started, prefs started, "+
		"orders succeeded, prefs succeeded, crm started, crm succeeded"; got != want &&
		got != strings.Replace(want, "orders succeeded, prefs succeeded", "prefs succeeded, orders succeeded", 1) {
		t.Errorf("events:\n%s\nwant:\n%s", got, want)
	}
	for _, e := range rec.events {
		if e.Run != "run-1" || e.At.IsZero() {
			t.Errorf("event %+v lacks its run or time", e)
		}
	}
}

// echo answers every request with 200, an ETag, and what it received:
// {"if_match": ..., "path": ..., "query": ...}.
func echo(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `"v1"`)
		got := map[string]string{"path": r.URL.EscapedPath(), "query": r.URL.RawQuery, "if_match": r.Header.Get("If-Match")}
		if err := json.NewEncoder(w).Encode(got); err != nil {
			t.Errorf("echo: %v", err)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestRun_SkipsCascade(t *testing.T) {
	t.Parallel()
	srv := echo(t)
	p := program(t, srv.URL, `{
	  "nodes": [
	    {"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/a"}},
	    {"id": "b", "kind": "http", "request": {"method": "GET", "url": "BASE/b"}},
	    {"id": "c", "kind": "http", "request": {"method": "GET", "url": "BASE/c"}},
	    {"id": "d", "kind": "http", "request": {"method": "GET", "url": "BASE/d"}}
	  ],
	  "edges": [
	    {"from": "a", "to": "b", "when": "nodes.a.status = 404"},
	    {"from": "b", "to": "c"},
	    {"from": "a", "to": "d", "when": "nodes.a.status = 200"}
	  ]
	}`)
	res, rec := execute(t, testEngine(Options{}), p, `{}`)
	if res.Status != StatusSucceeded {
		t.Fatalf("run %s: %v", res.Status, res.Err)
	}
	if got, want := statuses(res), "a succeeded, b skipped, c skipped, d succeeded"; got != want {
		t.Errorf("nodes: %s, want %s", got, want)
	}
	if got := rec.list(EventSkipped); got != "b skipped, c skipped" {
		t.Errorf("skip events: %s", got)
	}
}

func TestRun_JoinRunsWhenAnyEdgeIsTaken(t *testing.T) {
	t.Parallel()
	srv := echo(t)
	p := program(t, srv.URL, `{
	  "nodes": [
	    {"id": "a", "kind": "transform", "expr": "1"},
	    {"id": "b", "kind": "transform", "expr": "2"},
	    {"id": "c", "kind": "transform", "expr": "{ 'from_a': nodes.a.body, 'b_seen': $exists(nodes.b) }"}
	  ],
	  "edges": [
	    {"from": "a", "to": "c", "when": "true"},
	    {"from": "b", "to": "c", "when": "false"}
	  ],
	  "output": "nodes.c.body"
	}`)
	res, _ := execute(t, testEngine(Options{}), p, `{}`)
	if res.Status != StatusSucceeded {
		t.Fatalf("run %s: %v", res.Status, res.Err)
	}
	// b succeeded and is an ancestor, so c sees it even though b's edge
	// wasn't taken.
	if got, want := string(res.Output), `{"from_a":1,"b_seen":true}`; got != want {
		t.Errorf("output = %s, want %s", got, want)
	}
}

func TestRun_SeesOnlyAncestors(t *testing.T) {
	t.Parallel()
	// With one node at a time, b finishes before c starts. c still mustn't
	// see it: what an expression sees can't depend on timing.
	p := program(t, "", `{
	  "nodes": [
	    {"id": "a", "kind": "transform", "expr": "'a'"},
	    {"id": "b", "kind": "transform", "expr": "'b'"},
	    {"id": "c", "kind": "transform", "expr": "{ 'a': nodes.a.body, 'b_seen': $exists(nodes.b) }"}
	  ],
	  "edges": [{"from": "a", "to": "c"}],
	  "output": "nodes.c.body"
	}`)
	res, rec := execute(t, testEngine(Options{Concurrency: 1}), p, `{}`)
	if got := rec.list(EventStarted); got != "a started, b started, c started" {
		t.Fatalf("start order: %s", got)
	}
	if got, want := string(res.Output), `{"a":"a","b_seen":false}`; got != want {
		t.Errorf("output = %s, want %s", got, want)
	}
}

func TestRun_ReadsStatusAndHeaders(t *testing.T) {
	t.Parallel()
	srv := echo(t)
	p := program(t, srv.URL, `{
	  "nodes": [
	    {"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/a"}},
	    {"id": "b", "kind": "http", "request": {"method": "PUT", "url": "BASE/b",
	      "headers": {"If-Match": "{{ nodes.a.headers.etag }}"}}}
	  ],
	  "edges": [{"from": "a", "to": "b", "when": "nodes.a.status = 200"}],
	  "output": "nodes.b.body.if_match"
	}`)
	res, _ := execute(t, testEngine(Options{}), p, `{}`)
	if got := string(res.Output); got != `"\"v1\""` {
		t.Errorf("output = %s (%v), want the etag sent back", got, res.Err)
	}
}

func TestRun_EscapesPlaceholdersInURLs(t *testing.T) {
	t.Parallel()
	srv := echo(t)
	p := program(t, srv.URL, `{
	  "nodes": [{"id": "a", "kind": "http", "request": {"method": "GET",
	    "url": "BASE/v1/users/{{ input.id }}/orders?filter={{ input.filter }}",
	    "query": {"tag": "{{ input.filter }}"}}}],
	  "output": "nodes.a.body"
	}`)
	tests := []struct {
		name, input, want string
	}{
		{"query values can't add parameters", `{"id": "7", "filter": "a&admin=1"}`, `{"if_match":"","path":"/v1/users/7/orders","query":"filter=a%26admin%3D1&tag=a%26admin%3D1"}`},
		{"spaces and delimiters are escaped", `{"id": "a b;c=d+e", "filter": "x y"}`, `{"if_match":"","path":"/v1/users/a%20b%3Bc%3Dd%2Be/orders","query":"filter=x+y&tag=x+y"}`},
		{"a dot inside a value is fine", `{"id": "v1.2..3", "filter": "../x"}`, `{"if_match":"","path":"/v1/users/v1.2..3/orders","query":"filter=..%2Fx&tag=..%2Fx"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			res, _ := execute(t, testEngine(Options{}), p, tt.input)
			if res.Status != StatusSucceeded {
				t.Fatalf("run %s: %v", res.Status, res.Err)
			}
			if got := string(res.Output); got != tt.want {
				t.Errorf("upstream saw %s\nwant %s", got, tt.want)
			}
		})
	}
	// Each of these would name a different resource once a server decodes
	// and normalises the path, so none is sent.
	for _, id := range []string{`""`, `"."`, `".."`, `"../admin"`, `"7/delete"`, `"..\\admin"`} {
		res, _ := execute(t, testEngine(Options{}), p, `{"id": `+id+`, "filter": "x"}`)
		if res.Status != StatusFailed || !strings.Contains(res.Err.Error(), "isn't one segment") {
			t.Errorf("id %s: run %s, %v; want it refused", id, res.Status, res.Err)
		}
	}
}

func TestRun_FailFastCancelsInFlightNodes(t *testing.T) {
	t.Parallel()
	slowCancelled := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /fail", func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(20 * time.Millisecond) // let slow start first
		http.Error(w, "down", http.StatusInternalServerError)
	})
	mux.HandleFunc("GET /slow", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
			close(slowCancelled)
		case <-time.After(10 * time.Second):
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	p := program(t, srv.URL, `{
	  "nodes": [
	    {"id": "fails", "kind": "http", "request": {"method": "GET", "url": "BASE/fail"}},
	    {"id": "slow", "kind": "http", "request": {"method": "GET", "url": "BASE/slow"}},
	    {"id": "after", "kind": "transform", "expr": "1"}
	  ],
	  "edges": [{"from": "fails", "to": "after"}]
	}`)
	start := time.Now()
	res, _ := execute(t, testEngine(Options{}), p, `{}`)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("run took %v; the slow call wasn't cancelled", elapsed)
	}
	var ne *NodeError
	if res.Status != StatusFailed || !errors.As(res.Err, &ne) || ne.Node != "fails" || !strings.HasPrefix(res.Err.Error(), "node fails: ") {
		t.Errorf("run %s: %v; want failed by node fails", res.Status, res.Err)
	}
	if got, want := statuses(res), "fails failed, slow cancelled, after cancelled"; got != want {
		t.Errorf("nodes: %s, want %s", got, want)
	}
	var ue *upstream.Error
	if !errors.As(res.Nodes[0].Err, &ue) || ue.Status != http.StatusInternalServerError {
		t.Errorf("fails: %v, want an upstream 500", res.Nodes[0].Err)
	}
	if !errors.As(res.Err, &ue) {
		t.Errorf("the run's error %v doesn't unwrap to the node's", res.Err)
	}
	select {
	case <-slowCancelled:
	case <-time.After(time.Second):
		t.Error("the slow upstream never saw its request cancelled")
	}
}

func TestRun_RecoversPanickingNode(t *testing.T) {
	t.Parallel()
	// A nil client panics the moment an http node calls it.
	e := New(nil, Options{})
	p := program(t, "http://x.example", `{
	  "nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/"}}]
	}`)
	res, _ := execute(t, e, p, `{}`)
	var pe *PanicError
	if res.Status != StatusFailed || !errors.As(res.Nodes[0].Err, &pe) || len(pe.Stack) == 0 {
		t.Errorf("run %s, node error %v; want a failure carrying the panic and its stack", res.Status, res.Nodes[0].Err)
	}
}

func TestRun_HonoursConcurrencyLimit(t *testing.T) {
	t.Parallel()
	var now, peak atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := now.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		now.Add(-1)
		fmt.Fprint(w, `{}`)
	}))
	defer srv.Close()
	var nodes []string
	for i := range 12 {
		nodes = append(nodes, `{"id": "n`+string(rune('a'+i))+`", "kind": "http", "request": {"method": "GET", "url": "BASE/"}}`)
	}
	p := program(t, srv.URL, `{"nodes": [`+strings.Join(nodes, ",")+`]}`)
	res, _ := execute(t, testEngine(Options{Concurrency: 3}), p, `{}`)
	if res.Status != StatusSucceeded {
		t.Fatalf("run %s: %v", res.Status, res.Err)
	}
	if peak.Load() != 3 {
		t.Errorf("peak concurrency %d, want 3", peak.Load())
	}
}

func TestRun_StartsReadyNodesInDeclarationOrder(t *testing.T) {
	t.Parallel()
	p := program(t, "", `{
	  "nodes": [
	    {"id": "c", "kind": "transform", "expr": "1"},
	    {"id": "a", "kind": "transform", "expr": "1"},
	    {"id": "d", "kind": "transform", "expr": "1"},
	    {"id": "b", "kind": "transform", "expr": "1"}
	  ],
	  "edges": [{"from": "c", "to": "d"}]
	}`)
	for range 20 {
		_, rec := execute(t, testEngine(Options{Concurrency: 1}), p, `{}`)
		if got := rec.list(EventStarted); got != "c started, a started, d started, b started" {
			t.Fatalf("start order: %s", got)
		}
	}
}

func TestRun_TimesOut(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(10 * time.Second):
		}
	}))
	defer srv.Close()
	p := program(t, srv.URL, `{
	  "nodes": [
	    {"id": "slow", "kind": "http", "request": {"method": "GET", "url": "BASE/"}},
	    {"id": "next", "kind": "transform", "expr": "1"}
	  ],
	  "edges": [{"from": "slow", "to": "next"}]
	}`)
	start := time.Now()
	res, _ := execute(t, testEngine(Options{RunTimeout: 100 * time.Millisecond}), p, `{}`)
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("run took %v, want about 100ms", elapsed)
	}
	if res.Status != StatusFailed || !errors.Is(res.Err, ErrRunTimeout) {
		t.Errorf("run %s: %v; want failed by the timeout", res.Status, res.Err)
	}
	if got, want := statuses(res), "slow failed, next cancelled"; got != want {
		t.Errorf("nodes: %s, want %s", got, want)
	}
}

func TestRun_CallerCancels(t *testing.T) {
	t.Parallel()
	started := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	}))
	defer srv.Close()
	p := program(t, srv.URL, `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/"}}]}`)
	ctx, cancel := context.WithCancel(t.Context())
	go func() {
		<-started
		cancel()
	}()
	res, err := testEngine(Options{}).Run(ctx, p, "run-1", json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StatusCancelled || res.Nodes[0].Status != StatusCancelled {
		t.Errorf("run %s, node %s; want both cancelled", res.Status, res.Nodes[0].Status)
	}
}

func TestRun_RetriesWithIdempotencyKey(t *testing.T) {
	t.Parallel()
	keys := make(chan string, 5)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		keys <- r.Header.Get("Idempotency-Key")
		if hits.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		fmt.Fprint(w, `{"id": "c-1"}`)
	}))
	defer srv.Close()
	p := program(t, srv.URL, `{
	  "nodes": [{"id": "crm", "kind": "http", "request": {"method": "POST", "url": "BASE/",
	    "body": "{}", "retry": {"attempts": 3, "idempotent": true}}}]
	}`)
	res, rec := execute(t, testEngine(Options{}), p, `{}`)
	if res.Status != StatusSucceeded || res.Nodes[0].Attempts != 2 {
		t.Fatalf("run %s after %d attempts: %v", res.Status, res.Nodes[0].Attempts, res.Err)
	}
	if got := <-keys + "," + <-keys; got != "run-1:crm,run-1:crm" || len(keys) > 0 {
		t.Errorf("Idempotency-Key per attempt: %q, want the same key twice", got)
	}
	if got := rec.list(); got != "crm started, crm retrying, crm succeeded" {
		t.Errorf("events: %s", got)
	}
}

func TestRun_OutputFailures(t *testing.T) {
	t.Parallel()
	tests := []struct {
		output string
		want   error
	}{
		{"nodes.a.body.missing", transform.ErrNoValue},
		{"function() { 1 }", transform.ErrNotJSON},
	}
	for _, tt := range tests {
		p := program(t, "", `{"nodes": [{"id": "a", "kind": "transform", "expr": "{}"}], "output": "`+tt.output+`"}`)
		res, _ := execute(t, testEngine(Options{}), p, `{}`)
		if res.Status != StatusFailed || !errors.Is(res.Err, tt.want) {
			t.Errorf("output %q: run %s, %v; want failed with %v", tt.output, res.Status, res.Err, tt.want)
		}
	}
}

func TestRun_CapsTheDataDocument(t *testing.T) {
	t.Parallel()
	big := `"` + strings.Repeat("x", 9<<20) + `"`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, big)
	}))
	defer srv.Close()
	p := program(t, srv.URL, `{
	  "nodes": [
	    {"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/a"}},
	    {"id": "b", "kind": "http", "request": {"method": "GET", "url": "BASE/b"}},
	    {"id": "c", "kind": "transform", "expr": "1"}
	  ],
	  "edges": [{"from": "a", "to": "c"}, {"from": "b", "to": "c"}]
	}`)
	res, _ := execute(t, testEngine(Options{}), p, `{}`)
	if res.Status != StatusFailed || !strings.Contains(res.Err.Error(), "over the 16 MiB cap") {
		t.Errorf("run %s: %v; want c refused for its document size", res.Status, res.Err)
	}
}

func TestRun_RejectsInputThatIsntJSON(t *testing.T) {
	t.Parallel()
	p := program(t, "", `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}]}`)
	if _, err := testEngine(Options{}).Run(t.Context(), p, "run-1", json.RawMessage(`{`), nil); err == nil {
		t.Error("Run accepted input that isn't JSON")
	}
}

// Not parallel: it counts the process's goroutines.
func TestRun_LeavesNoGoroutinesBehind(t *testing.T) {
	srv := echo(t)
	p := program(t, srv.URL, specExample)
	before := runtime.NumGoroutine()
	for range 5 {
		// The spec example's server isn't running here, so user gets a 404
		// and the run fails fast: both paths end their goroutines.
		execute(t, testEngine(Options{}), p, `{"user_id": "u-42"}`)
		execute(t, testEngine(Options{}), program(t, "", `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}]}`), `{}`)
	}
	srv.CloseClientConnections()
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > before && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if after := runtime.NumGoroutine(); after > before {
		t.Errorf("goroutines: %d before, %d after", before, after)
	}
}

func TestCompile_ReportsExpressionProblemsWithTheRest(t *testing.T) {
	t.Parallel()
	var d workflow.Definition
	if err := json.Unmarshal([]byte(`{
	  "nodes": [
	    {"id": "a", "kind": "http", "request": {"method": "GET", "url": "https://x.example/{{ input. }}",
	      "headers": {"X-Key": "{{ $( }}"}, "query": {"q/1": "{{ ) }}"}, "body": "{"}},
	    {"id": "B", "kind": "transform", "expr": "nodes.a."}
	  ],
	  "edges": [{"from": "a", "to": "B", "when": "=="}],
	  "output": "]"
	}`), &d); err != nil {
		t.Fatal(err)
	}
	_, err := Compile(&d)
	var ps workflow.Problems
	if !errors.As(err, &ps) {
		t.Fatalf("Compile error = %v, want workflow.Problems", err)
	}
	var got []string
	for _, p := range ps {
		got = append(got, p.Pointer+" "+p.Code)
	}
	want := []string{
		"/nodes/1/id invalid_id",
		"/nodes/0/request/url invalid_expression",
		"/nodes/0/request/headers/X-Key invalid_expression",
		"/nodes/0/request/query/q~11 invalid_expression",
		"/nodes/0/request/body invalid_expression",
		"/nodes/1/expr invalid_expression",
		"/edges/0/when invalid_expression",
		"/output invalid_expression",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("problems:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestCompile_ChecksJSONSchemas(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, schemas, want string // want: "pointer code", or "" for no problems
	}{
		{"valid", `"input_schema": {"type": "object", "required": ["user_id"], "properties": {"user_id": {"type": "string"}}}`, ""},
		{"a ref inside the schema", `"input_schema": {"$defs": {"id": {"type": "string"}}, "properties": {"user_id": {"$ref": "#/$defs/id"}}}`, ""},
		{"not a schema", `"input_schema": {"type": 5}`, "/input_schema invalid_schema"},
		{"output too", `"output_schema": {"minimum": "zero"}`, "/output_schema invalid_schema"},
		// The library's default loader reads local files; none may load.
		{"a ref to a local file", `"input_schema": {"$ref": "file:///etc/passwd"}`, "/input_schema invalid_schema"},
		{"a ref to a remote schema", `"input_schema": {"$ref": "https://example.com/schema.json"}`, "/input_schema invalid_schema"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var d workflow.Definition
			if err := json.Unmarshal([]byte(`{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}], `+tt.schemas+`}`), &d); err != nil {
				t.Fatal(err)
			}
			_, err := Compile(&d)
			var got []string
			var ps workflow.Problems
			if errors.As(err, &ps) {
				for _, p := range ps {
					got = append(got, p.Pointer+" "+p.Code)
					if strings.Contains(p.Detail, "/Users/") || strings.Contains(p.Detail, "root:") {
						t.Errorf("detail leaks the server's files: %s", p.Detail)
					}
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if strings.Join(got, ", ") != tt.want {
				t.Errorf("problems = %q, want %q", strings.Join(got, ", "), tt.want)
			}
		})
	}
}

func TestRun_EventsThatEndANodeCarryItsResult(t *testing.T) {
	t.Parallel()
	srv := echo(t)
	p := program(t, srv.URL, `{
	  "nodes": [
	    {"id": "a", "kind": "http", "request": {"method": "POST", "url": "BASE/v1/{{ input.id }}",
	      "headers": {"X-Trace": "t-{{ input.id }}"}, "body": "{ 'id': input.id }"}},
	    {"id": "b", "kind": "transform", "expr": "nodes.a.status"},
	    {"id": "c", "kind": "transform", "expr": "1"}
	  ],
	  "edges": [{"from": "a", "to": "b"}, {"from": "a", "to": "c", "when": "false"}]
	}`)
	_, rec := execute(t, testEngine(Options{}), p, `{"id": "7"}`)
	ends := map[string]*NodeResult{}
	for _, e := range rec.events {
		switch e.Kind {
		case EventStarted, EventRetrying:
			if e.Result != nil {
				t.Errorf("%s %s carries a result", e.Node, e.Kind)
			}
		default:
			if e.Result == nil || e.Result.ID != e.Node || string(e.Result.Status) != string(e.Kind) {
				t.Errorf("%s %s: result %+v", e.Node, e.Kind, e.Result)
			}
			ends[e.Node] = e.Result
		}
	}
	a := ends["a"]
	if a == nil || a.Request == nil {
		t.Fatalf("a's result lacks the request it sent: %+v", a)
	}
	if a.Request.Method != "POST" || a.Request.URL != srv.URL+"/v1/7" || a.Request.Header.Get("X-Trace") != "t-7" || string(a.Request.Body) != `{"id":"7"}` {
		t.Errorf("sent request = %+v, body %s", a.Request, a.Request.Body)
	}
	if b := ends["b"]; b == nil || string(b.Body) != "200" || b.Request != nil {
		t.Errorf("transform b = %+v", b)
	}
	if c := ends["c"]; c == nil || c.Status != StatusSkipped {
		t.Errorf("skipped c = %+v", c)
	}
}

func TestProgram_CheckInput(t *testing.T) {
	t.Parallel()
	p := program(t, "", `{
	  "nodes": [{"id": "a", "kind": "transform", "expr": "1"}],
	  "input_schema": {"type": "object", "required": ["user_id"],
	    "properties": {"user_id": {"type": "string"}, "limit": {"type": "integer", "maximum": 10}}}
	}`)
	tests := []struct {
		input, want string // each problem as "pointer code: detail", sorted
	}{
		{`{"user_id": "u-1"}`, ""},
		{`{"user_id": "u-1", "limit": 99}`, "/limit invalid_input: maximum: got 99, want 10"},
		{`{"user_id": 7, "limit": 1.5}`, "/limit invalid_input: got number, want integer | /user_id invalid_input: got number, want string"},
		{`{}`, " invalid_input: missing property 'user_id'"},
		{`[`, " invalid_json: the input isn't JSON"},
	}
	for _, tt := range tests {
		var got []string
		for _, p := range p.CheckInput(json.RawMessage(tt.input)) {
			got = append(got, p.Pointer+" "+p.Code+": "+p.Detail)
		}
		slices.Sort(got)
		if g := strings.Join(got, " | "); g != tt.want {
			t.Errorf("CheckInput(%s) = %q, want %q", tt.input, g, tt.want)
		}
	}
	if ps := program(t, "", `{"nodes": []}`).CheckInput(json.RawMessage(`"anything"`)); ps != nil {
		t.Errorf("without an input_schema: %v", ps)
	}
}
