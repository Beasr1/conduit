package httpapi

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
)

// TestEndToEnd is plan 03's acceptance test: the API driven over HTTP, the
// way a client would, against the compose Postgres and test upstreams.
func TestEndToEnd(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)
	base := usersUpstream(t).URL

	send := func(method, path, body string, headers ...string) reply {
		t.Helper()
		req, err := http.NewRequestWithContext(t.Context(), method, srv.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+testToken)
		req.Header.Set("Content-Type", "application/json")
		for i := 0; i+1 < len(headers); i += 2 {
			req.Header.Set(headers[i], headers[i+1])
		}
		res, err := srv.Client().Do(req)
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
	want := func(r reply, status int, what string) {
		t.Helper()
		if r.status != status {
			t.Fatalf("%s = %d, want %d; body %s", what, r.status, status, r.body)
		}
	}

	// A workflow, then two more revisions: the second saved on a stale
	// revision, and refused.
	slug := newSlug(t)
	r := send(http.MethodPost, "/v1/workflows", `{"slug": "`+slug+`", "name": "Greet", "definition": {"nodes": []}}`)
	want(r, http.StatusCreated, "create")
	id := strict[gen.WorkflowRevision](t, r.body).Workflow.ID
	def := strings.ReplaceAll(greetDef, "BASE", base)
	r = send(http.MethodPut, "/v1/workflows/"+id+"/draft", def, "If-Match", `"1"`)
	want(r, http.StatusOK, "save on revision 1")
	if r.header.Get("ETag") != `"2"` {
		t.Errorf("ETag = %q", r.header.Get("ETag"))
	}
	r = send(http.MethodPut, "/v1/workflows/"+id+"/draft", def, "If-Match", `"1"`)
	want(r, http.StatusPreconditionFailed, "save on revision 1 again")
	if p := problemOf(t, r); p.Code != "revision_mismatch" {
		t.Errorf("stale save: %+v", p)
	}
	want(send(http.MethodPost, "/v1/workflows/"+id+"/publish", `{"revision": 2}`), http.StatusOK, "publish")

	// A run, followed live: its events arrive in order, then its record.
	r = send(http.MethodPost, "/v1/workflows/"+id+"/runs", `{"input": {"user_id": "7"}}`)
	want(r, http.StatusAccepted, "start a run")
	run := strict[gen.Run](t, r.body)
	r = send(http.MethodGet, "/v1/runs/"+run.ID+"/events", "")
	want(r, http.StatusOK, "events")
	if got := eventList(t, readEvents(t, bytes.NewReader(r.body))); got != "1 user started, 2 user succeeded, 3 greet started, 4 greet succeeded, end run succeeded" {
		t.Errorf("events: %s", got)
	}
	r = send(http.MethodGet, "/v1/runs/"+run.ID, "")
	want(r, http.StatusOK, "get the run")
	got := strict[gen.Run](t, r.body)
	if got.Revision != 2 || string(got.Output) != `{"greeting":"Hello, Ada"}` || len(got.Nodes) != 2 ||
		got.Nodes[0].Response.Status != 200 || got.Nodes[0].Request.Headers["authorization"] != "[redacted]" {
		t.Errorf("run = %s", r.body)
	}

	// The served endpoint: the output, or problem details naming the node.
	r = send(http.MethodPost, "/serve/"+slug, `{"user_id": "7"}`)
	want(r, http.StatusOK, "serve")
	if string(r.body) != `{"greeting":"Hello, Ada"}` {
		t.Errorf("served output = %s", r.body)
	}
	for _, tt := range []struct {
		input  string
		status int
		code   string
	}{
		{`{"user_id": 7}`, http.StatusBadRequest, "invalid_input"},
		{`{"user_id": "500"}`, http.StatusBadGateway, "upstream_failed"},
		{`{"user_id": "slow"}`, http.StatusGatewayTimeout, "timeout"},
	} {
		r := send(http.MethodPost, "/serve/"+slug, tt.input)
		want(r, tt.status, "serve "+tt.input)
		if p := problemOf(t, r); p.Code != tt.code || (tt.status != http.StatusBadRequest && p.Node != "user") {
			t.Errorf("serve %s: %+v", tt.input, p)
		}
	}
}
