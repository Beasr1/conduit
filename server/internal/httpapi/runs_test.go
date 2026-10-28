package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/runner"
	"github.com/Beasr1/conduit/server/internal/store"
)

// greetDef calls BASE/users/{user_id} with a secret header and query
// parameter, then greets the user.
const greetDef = `{
  "nodes": [
    {"id": "user", "kind": "http", "request": {
      "method": "GET", "url": "BASE/users/{{ input.user_id }}",
      "headers": {"Authorization": "Bearer s3cret"}, "query": {"api_key": "k-1"}, "timeout_ms": 1000}},
    {"id": "greet", "kind": "transform", "expr": "'Hello, ' & nodes.user.body.name"}
  ],
  "edges": [{"from": "user", "to": "greet"}],
  "output": "{ 'greeting': nodes.greet.body }",
  "input_schema": {"type": "object", "required": ["user_id"], "properties": {"user_id": {"type": "string"}}}
}`

// usersUpstream answers greetDef: user 7 at once, user 8 after a second,
// 500 with an error, and slow not before the caller gives up.
func usersUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/users/7":
			fmt.Fprint(w, `{"id": "7", "name": "Ada"}`)
		case "/users/8":
			time.Sleep(time.Second)
			fmt.Fprint(w, `{"id": "8", "name": "Grace"}`)
		case "/users/500":
			http.Error(w, `{"error": "down"}`, http.StatusInternalServerError)
		case "/users/slow":
			<-r.Context().Done()
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// published creates a workflow from def, with BASE standing for base, and
// publishes revision 1.
func published(t *testing.T, base, def string) gen.WorkflowRevision {
	t.Helper()
	wr := create(t, strings.ReplaceAll(def, "BASE", base))
	if r := call(t, http.MethodPost, "/v1/workflows/"+wr.Workflow.ID+"/publish", `{"revision": 1}`); r.status != http.StatusOK {
		t.Fatalf("publish = %d %s", r.status, r.body)
	}
	return wr
}

// strict decodes JSON that must have no field T lacks: what the server sends
// matches the schema the types are generated from.
func strict[T any](t *testing.T, b []byte) T {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var v T
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("decode %T: %v; body %s", v, err, b)
	}
	return v
}

type sseEvent struct{ id, name, data string }

// readEvents parses a server-sent event stream to its end. Comment lines,
// the keep-alives, are skipped.
func readEvents(t *testing.T, r io.Reader) []sseEvent {
	t.Helper()
	var out []sseEvent
	var e sseEvent
	sc := bufio.NewScanner(r)
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		line := sc.Text()
		field, value, _ := strings.Cut(line, ": ")
		switch field {
		case "":
			if e.name != "" {
				out = append(out, e)
			}
			e = sseEvent{}
		case "id":
			e.id = value
		case "event":
			e.name = value
		case "data":
			e.data = value
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("read the stream: %v", err)
	}
	return out
}

// eventList renders node events as "1 user started" and the run's as
// "end run succeeded".
func eventList(t *testing.T, events []sseEvent) string {
	t.Helper()
	var out []string
	for _, e := range events {
		switch e.name {
		case "node":
			n := strict[gen.NodeEvent](t, []byte(e.data))
			out = append(out, fmt.Sprintf("%s %s %s", e.id, n.Node, n.Kind))
		case "run":
			r := strict[gen.Run](t, []byte(e.data))
			out = append(out, fmt.Sprintf("%s run %s", e.id, r.Status))
		default:
			t.Errorf("unexpected event %q", e.name)
		}
	}
	return strings.TrimSpace(strings.Join(out, ", "))
}

func startRun(t *testing.T, workflowID, body string) gen.Run {
	t.Helper()
	r := call(t, http.MethodPost, "/v1/workflows/"+workflowID+"/runs", body)
	if r.status != http.StatusAccepted {
		t.Fatalf("start run = %d %s", r.status, r.body)
	}
	run := strict[gen.Run](t, r.body)
	if loc := r.header.Get("Location"); loc != "/v1/runs/"+run.ID {
		t.Errorf("Location = %q", loc)
	}
	return run
}

func TestRuns_StartFollowAndFetch(t *testing.T) {
	t.Parallel()
	wr := create(t, strings.ReplaceAll(greetDef, "BASE", usersUpstream(t).URL))
	run := startRun(t, wr.Workflow.ID, `{"input": {"user_id": "7"}}`)
	if run.Status != gen.RunStatusRunning || run.Trigger != gen.RunTriggerEditor || run.Revision != 1 || string(run.Input) != `{"user_id":"7"}` {
		t.Errorf("started run = %+v", run)
	}

	// The handler returns once the run's event is out, so the recorder
	// holds the whole stream.
	r := call(t, http.MethodGet, "/v1/runs/"+run.ID+"/events", "")
	if r.status != http.StatusOK || r.header.Get("Content-Type") != "text/event-stream" ||
		r.header.Get("X-Accel-Buffering") != "no" || r.header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("events = %d, headers %v", r.status, r.header)
	}
	events := readEvents(t, bytes.NewReader(r.body))
	if got, want := eventList(t, events), "1 user started, 2 user succeeded, 3 greet started, 4 greet succeeded, end run succeeded"; got != want {
		t.Fatalf("events: %s\nwant:   %s", got, want)
	}
	if end := strict[gen.Run](t, []byte(events[4].data)); string(end.Output) != `{"greeting":"Hello, Ada"}` || end.EndedAt.IsZero() {
		t.Errorf("run event = %s", events[4].data)
	}
	if n := strict[gen.NodeEvent](t, []byte(events[1].data)); n.HTTPStatus != 200 || n.Attempt != 1 {
		t.Errorf("user's end = %s", events[1].data)
	}

	r = call(t, http.MethodGet, "/v1/runs/"+run.ID, "")
	got := strict[gen.Run](t, r.body)
	if r.status != http.StatusOK || got.Status != gen.RunStatusSucceeded || len(got.Nodes) != 2 {
		t.Fatalf("GET run = %d %s", r.status, r.body)
	}
	user, greet := got.Nodes[0], got.Nodes[1]
	if user.Node != "user" || user.Status != gen.NodeRunStatusSucceeded || user.Attempts != 1 || user.StartedAt.IsZero() ||
		!strings.HasSuffix(user.Request.URL, "/users/7?api_key=[redacted]") || user.Request.Method != "GET" ||
		user.Request.Headers["authorization"] != "[redacted]" || user.Response.Status != 200 {
		t.Errorf("user = %+v", user)
	}
	if greet.Node != "greet" || string(greet.Response.Body) != `"Hello, Ada"` || greet.Request.URL != "" {
		t.Errorf("greet = %+v", greet)
	}
}

func TestRuns_EventsResumeAfterLastEventID(t *testing.T) {
	t.Parallel()
	wr := create(t, strings.ReplaceAll(greetDef, "BASE", usersUpstream(t).URL))
	run := startRun(t, wr.Workflow.ID, `{"input": {"user_id": "7"}}`)
	call(t, http.MethodGet, "/v1/runs/"+run.ID+"/events", "") // waits for the end

	r := call(t, http.MethodGet, "/v1/runs/"+run.ID+"/events", "", "Last-Event-ID", "3")
	if got := eventList(t, readEvents(t, bytes.NewReader(r.body))); got != "4 greet succeeded, end run succeeded" {
		t.Errorf("after 3: %s", got)
	}
	r = call(t, http.MethodGet, "/v1/runs/"+run.ID+"/events", "", "Last-Event-ID", "4")
	if got := eventList(t, readEvents(t, bytes.NewReader(r.body))); got != "end run succeeded" {
		t.Errorf("after the last node event: %s", got)
	}
	// The client has everything: 204 tells an EventSource to stop.
	if r := call(t, http.MethodGet, "/v1/runs/"+run.ID+"/events", "", "Last-Event-ID", "end"); r.status != http.StatusNoContent || len(r.body) != 0 {
		t.Errorf("after end = %d %q", r.status, r.body)
	}
	if p := problemOf(t, call(t, http.MethodGet, "/v1/runs/"+run.ID+"/events", "", "Last-Event-ID", "x")); p.Status != 400 {
		t.Errorf("a Last-Event-ID that isn't an event's: %+v", p)
	}
	for _, last := range []string{"", "end"} {
		r := call(t, http.MethodGet, "/v1/runs/01890000-0000-7000-8000-000000000000/events", "", "Last-Event-ID", last)
		if p := problemOf(t, r); p.Status != 404 {
			t.Errorf("an unknown run, Last-Event-ID %q: %+v", last, p)
		}
	}
}

func TestStartRun_Refusals(t *testing.T) {
	t.Parallel()
	good := create(t, strings.ReplaceAll(greetDef, "BASE", "http://x.example")).Workflow.ID
	bad := create(t, invalidDef).Workflow.ID
	tests := []struct {
		name, workflow, body string
		status               int
		code, pointers       string
	}{
		{"input the schema refuses", good, `{"input": {"user_id": 7}}`, 400, "invalid_input", "/user_id invalid_input"},
		{"no input", good, `{}`, 400, "invalid_input", " invalid_input"},
		{"a revision with problems", bad, `{}`, 422, "invalid_definition", "/nodes/0/id invalid_id, /nodes/0/expr invalid_expression"},
		{"a revision that doesn't exist", good, `{"revision": 9}`, 404, "not_found", ""},
		{"a workflow that doesn't exist", "01890000-0000-7000-8000-000000000000", `{}`, 404, "not_found", ""},
		{"a revision that isn't a number", good, `{"revision": "latest"}`, 422, "invalid_request", "/revision invalid_type"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			p := problemOf(t, call(t, http.MethodPost, "/v1/workflows/"+tt.workflow+"/runs", tt.body))
			if p.Status != tt.status || p.Code != tt.code || pointers(p) != tt.pointers {
				t.Errorf("got %d %s %q, want %d %s %q", p.Status, p.Code, pointers(p), tt.status, tt.code, tt.pointers)
			}
		})
	}
}

func TestListRuns_PagesNewestFirst(t *testing.T) {
	t.Parallel()
	id := create(t, validDef).Workflow.ID
	first, second := startRun(t, id, `{}`), startRun(t, id, `{}`)

	var seen []string
	before := ""
	for range 3 {
		r := call(t, http.MethodGet, "/v1/runs?limit=1&workflow_id="+id+"&before="+before, "")
		page := strict[gen.RunList](t, r.body)
		for _, run := range page.Runs {
			seen = append(seen, run.ID)
		}
		if before = page.Next; before == "" {
			break
		}
	}
	if strings.Join(seen, ",") != second.ID+","+first.ID {
		t.Errorf("pages = %v, want %s then %s", seen, second.ID, first.ID)
	}
	if p := problemOf(t, call(t, http.MethodGet, "/v1/runs?limit=500", "")); p.Status != 400 {
		t.Errorf("limit 500: %+v", p)
	}
}

func TestGetRun_NotFound(t *testing.T) {
	t.Parallel()
	for _, id := range []string{"01890000-0000-7000-8000-000000000000", "not-a-uuid"} {
		if p := problemOf(t, call(t, http.MethodGet, "/v1/runs/"+id, "")); p.Status != 404 || p.Code != "not_found" {
			t.Errorf("GET /v1/runs/%s: %+v", id, p)
		}
	}
}

func TestServe(t *testing.T) {
	t.Parallel()
	up := usersUpstream(t)
	greet := published(t, up.URL, greetDef).Workflow.Slug
	noOutput := published(t, up.URL, `{"nodes": []}`).Workflow.Slug
	broken := published(t, up.URL, `{"nodes": [{"id": "t", "kind": "transform", "expr": "$number('one')"}]}`).Workflow.Slug
	unpublished := create(t, validDef).Workflow.Slug

	tests := []struct {
		name, slug, body string
		status           int
		want             string // the body, or the problem's code and node
	}{
		{"the output", greet, `{"user_id": "7"}`, 200, `{"greeting":"Hello, Ada"}`},
		{"no output expression", noOutput, ``, 200, `null`},
		{"input the schema refuses", greet, `{"user_id": 7}`, 400, "invalid_input"},
		{"a body that isn't JSON", greet, `{`, 400, "invalid_request"},
		{"an upstream fails", greet, `{"user_id": "500"}`, 502, "upstream_failed user"},
		{"an upstream is too slow", greet, `{"user_id": "slow"}`, 504, "timeout user"},
		{"an expression fails", broken, ``, 500, "workflow_error t"},
		{"no such slug", "no-such-slug", ``, 404, "not_found"},
		{"never published", unpublished, ``, 404, "not_found"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			r := call(t, http.MethodPost, "/serve/"+tt.slug, tt.body)
			if r.status != tt.status {
				t.Fatalf("status = %d, want %d; body %s", r.status, tt.status, r.body)
			}
			if tt.status == 200 {
				if string(r.body) != tt.want || r.header.Get("Content-Type") != "application/json" {
					t.Errorf("body %s, Content-Type %q; want %s", r.body, r.header.Get("Content-Type"), tt.want)
				}
				return
			}
			p := problemOf(t, r)
			if got := strings.TrimSpace(p.Code + " " + p.Node); got != tt.want {
				t.Errorf("problem %q, want %q: %s", got, tt.want, r.body)
			}
			// A run that failed names itself, for GET /v1/runs/{id}.
			if tt.status >= 500 && !strings.HasPrefix(p.Instance, "/v1/runs/") {
				t.Errorf("instance = %q", p.Instance)
			}
		})
	}
}

func TestServe_BusyAtTheCap(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	arrived := make(chan struct{}, 1)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		arrived <- struct{}{}
		<-release
		fmt.Fprint(w, `{}`)
	}))
	t.Cleanup(up.Close)
	t.Cleanup(func() { close(release) })
	capped := newRouter(db, runner.Options{MaxRuns: 1}, 0)
	wr := published(t, up.URL, `{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/"}}]}`)

	send := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequestWithContext(t.Context(), method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+testToken)
		rec := httptest.NewRecorder()
		capped.ServeHTTP(rec, req)
		return rec
	}
	if rec := send(http.MethodPost, "/v1/workflows/"+wr.Workflow.ID+"/runs", `{}`); rec.Code != http.StatusAccepted {
		t.Fatalf("start = %d %s", rec.Code, rec.Body)
	}
	<-arrived
	rec := send(http.MethodPost, "/serve/"+wr.Workflow.Slug, ``)
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "5" || !strings.Contains(rec.Body.String(), `"code":"busy"`) {
		t.Errorf("at the cap = %d, Retry-After %q, %s", rec.Code, rec.Header().Get("Retry-After"), rec.Body)
	}
}

func TestEvents_BusyAtTheStreamCap(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
			fmt.Fprint(w, `{}`)
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(up.Close)
	// A run's events live in the runner that started it, so the run starts
	// on this router too.
	srv := httptest.NewServer(newRouter(db, runner.Options{}, 1))
	t.Cleanup(srv.Close)
	request := func(method, path, body string) *http.Request {
		t.Helper()
		req, err := http.NewRequestWithContext(t.Context(), method, srv.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+testToken)
		return req
	}
	// send makes a request and reads the whole answer.
	send := func(method, path, body string) reply {
		t.Helper()
		res, err := srv.Client().Do(request(method, path, body))
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		return reply{status: res.StatusCode, header: res.Header, body: b}
	}
	id := create(t, strings.ReplaceAll(`{"nodes": [{"id": "a", "kind": "http", "request": {"method": "GET", "url": "BASE/"}}]}`, "BASE", up.URL)).Workflow.ID
	run := strict[gen.Run](t, send(http.MethodPost, "/v1/workflows/"+id+"/runs", `{}`).body)
	events := "/v1/runs/" + run.ID + "/events"

	first, err := srv.Client().Do(request(http.MethodGet, events, ""))
	if err != nil {
		t.Fatal(err)
	}
	defer first.Body.Close()
	if first.StatusCode != http.StatusOK {
		t.Fatalf("first stream = %d", first.StatusCode)
	}
	second := send(http.MethodGet, events, "")
	if second.status != http.StatusServiceUnavailable || second.header.Get("Retry-After") != "5" || !strings.Contains(string(second.body), `"code":"busy"`) {
		t.Errorf("a second stream at the cap = %d, Retry-After %q, %s", second.status, second.header.Get("Retry-After"), second.body)
	}
	close(release)
	// The first stream ends with its run, and frees its place before its
	// client sees the end.
	if got := eventList(t, readEvents(t, first.Body)); got != "1 a started, 2 a succeeded, end run succeeded" {
		t.Errorf("first stream: %s", got)
	}
	if third := send(http.MethodGet, events, ""); third.status != http.StatusOK {
		t.Errorf("a stream once the first ended = %d %s", third.status, third.body)
	}
}

// The server's WriteTimeout is for ordinary answers. An event stream lasts
// as long as its run, and outlives it.
func TestEvents_OutliveTheWriteTimeout(t *testing.T) {
	t.Parallel()
	srv := httptest.NewUnstartedServer(router)
	srv.Config.WriteTimeout = 300 * time.Millisecond
	srv.Start()
	t.Cleanup(srv.Close)
	// User 8 answers after a second: the run ends well past the timeout.
	wr := create(t, strings.ReplaceAll(`{"nodes": [{"id": "user", "kind": "http", "request": {"method": "GET", "url": "BASE/users/8"}}]}`, "BASE", usersUpstream(t).URL))
	run := startRun(t, wr.Workflow.ID, `{}`)

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, srv.URL+"/v1/runs/"+run.ID+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+testToken)
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if got := eventList(t, readEvents(t, res.Body)); got != "1 user started, 2 user succeeded, end run succeeded" {
		t.Errorf("events: %s", got)
	}
}

// fakeEvents hands a stream each batch sent on it, and io.EOF once it's
// closed: a run, as far as the stream can tell.
type fakeEvents chan []runner.Event

func (f fakeEvents) Next(ctx context.Context) ([]runner.Event, error) {
	select {
	case batch, ok := <-f:
		if !ok {
			return nil, io.EOF
		}
		return batch, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

var runEnded = []runner.Event{{Run: &store.Run{ID: "r", Status: "succeeded", Input: json.RawMessage(`null`)}}}

func TestEventStream_KeepsAnIdleStreamAlive(t *testing.T) {
	t.Parallel()
	synctest.Test(t, func(t *testing.T) {
		run := make(fakeEvents)
		rec := httptest.NewRecorder()
		s := eventStream{ctx: t.Context(), events: run, log: slog.New(slog.DiscardHandler)}
		done := make(chan error)
		go func() { done <- s.VisitStreamRunEventsResponse(rec) }()

		time.Sleep(keepAlive + time.Second)
		run <- runEnded
		close(run)
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		if body := rec.Body.String(); !strings.HasPrefix(body, ": keep-alive\n\nid: end\nevent: run\ndata: {") {
			t.Errorf("stream = %q; want a keep-alive, then the run", body)
		}
	})
}

func TestEventStream_EndsWhenTheClientGoes(t *testing.T) {
	t.Parallel()
	synctest.Test(t, func(t *testing.T) {
		ctx, leave := context.WithCancel(t.Context())
		s := eventStream{ctx: ctx, events: make(fakeEvents), log: slog.New(slog.DiscardHandler)}
		done := make(chan error)
		go func() { done <- s.VisitStreamRunEventsResponse(httptest.NewRecorder()) }()
		synctest.Wait()
		leave()
		if err := <-done; err != nil {
			t.Error(err)
		}
	})
}

// pipeWriter is a ResponseWriter that writes down a net.Pipe, which has no
// buffer: a client that doesn't read blocks every write, as a full socket
// does.
type pipeWriter struct {
	conn   net.Conn
	header http.Header
}

func (p *pipeWriter) Header() http.Header                { return p.header }
func (p *pipeWriter) WriteHeader(int)                    {}
func (p *pipeWriter) Write(b []byte) (int, error)        { return p.conn.Write(b) }
func (p *pipeWriter) Flush()                             {}
func (p *pipeWriter) SetWriteDeadline(t time.Time) error { return p.conn.SetWriteDeadline(t) }

// A client that stops reading is dropped once a write has waited writeWait,
// rather than holding its handler for ever.
func TestEventStream_DropsAClientThatStopsReading(t *testing.T) {
	t.Parallel()
	synctest.Test(t, func(t *testing.T) {
		server, client := net.Pipe()
		defer client.Close() // open, and never read
		s := eventStream{ctx: t.Context(), events: make(fakeEvents, 1), log: slog.New(slog.DiscardHandler)}
		s.events.(fakeEvents) <- runEnded
		start := time.Now()
		if err := s.VisitStreamRunEventsResponse(&pipeWriter{conn: server, header: http.Header{}}); err != nil {
			t.Fatal(err)
		}
		if waited := time.Since(start); waited != writeWait {
			t.Errorf("the stream ended after %v, want %v", waited, writeWait)
		}
	})
}
