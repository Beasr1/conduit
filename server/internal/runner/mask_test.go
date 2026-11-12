package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/upstream"
)

// A secret is masked wherever it's copied whole, as text, as JSON writes
// it, and as a URL escapes it; a short one only where a whole string is
// it, as inside longer text it would hide what isn't it (plan 06).
func TestMasker(t *testing.T) {
	t.Parallel()
	// By name, as the store lists them: inner, a part of long, comes first.
	m := newMasker([]store.Constant{
		{Name: "inner", Secret: true, Value: `sk_live "q"`},
		{Name: "long", Secret: true, Value: `sk_live "q" & <x> /y`},
		{Name: "pin", Secret: true, Value: "4821"},
		{Name: "plain", Value: "https://crm.example.com"},
	})
	for _, tt := range []struct{ in, want string }{
		{`token sk_live "q" & <x> /y here`, "token [secret long] here"},
		{"key=sk_live+%22q%22+%26+%3Cx%3E+%2Fy", "key=[secret long]"},
		{"/v1/sk_live%20%22q%22%20&%20%3Cx%3E%20%2Fy", "/v1/[secret long]"},
		{`say sk_live "q" alone`, "say [secret inner] alone"},
		{"4821", "[secret pin]"},
		{"pin 4821", "pin 4821"},
		{"https://crm.example.com", "https://crm.example.com"},
	} {
		if got := m.text(tt.in); got != tt.want {
			t.Errorf("text(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
	escaped, err := json.Marshal(map[string]any{"a": `sk_live "q" & <x> /y`, "b": "4821", "c": "pin 4821", "d": 4821})
	if err != nil {
		t.Fatal(err)
	}
	var unescaped bytes.Buffer
	enc := json.NewEncoder(&unescaped)
	enc.SetEscapeHTML(false)
	if err := enc.Encode([]string{`sk_live "q" & <x> /y`}); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct{ in, want string }{
		{string(escaped), `{"a":"[secret long]","b":"[secret pin]","c":"pin 4821","d":4821}`},
		{strings.TrimSpace(unescaped.String()), `["[secret long]"]`},
	} {
		if got := string(m.json([]byte(tt.in))); got != tt.want {
			t.Errorf("json(%s) = %s, want %s", tt.in, got, tt.want)
		}
	}
	if !json.Valid(m.json(escaped)) {
		t.Error("masked JSON isn't JSON")
	}
}

// secrets makes two secret constants of the test's own, a long one and a
// short one, and gives back their names and values.
func secrets(t *testing.T) (long, longValue, short, shortValue string) {
	t.Helper()
	tag := strings.ReplaceAll(slug(t), "-", "_")
	long, longValue = "long_"+tag, "sk_live_"+tag+"_0123456789"
	// Its own value too: two secrets of one value are masked by either name.
	short, shortValue = "pin_"+tag, tag[len(tag)-6:]
	for name, v := range map[string]string{long: longValue, short: shortValue} {
		if _, err := db.CreateConstant(t.Context(), name, v, true, store.Provenance{Actor: "token"}); err != nil {
			t.Fatal(err)
		}
	}
	return long, longValue, short, shortValue
}

// left is everything a run left in the database, as text: its row and its
// nodes'.
func left(t *testing.T, runID string) string {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(t.Context())
	var row, nodes string
	if err := conn.QueryRow(t.Context(), `SELECT row_to_json(r)::text FROM runs r WHERE id = $1::uuid`, runID).Scan(&row); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(t.Context(), `SELECT COALESCE(json_agg(n)::text, '') FROM node_runs n WHERE run_id = $1::uuid`, runID).Scan(&nodes); err != nil {
		t.Fatal(err)
	}
	return row + nodes
}

// A run reads its constants' real values, and sends them where its
// expressions put them; and no copy of a secret is left in what it keeps or
// answers: its input, its nodes' records, its events, its answer, its
// logs (plan 06).
func TestRun_MasksSecrets(t *testing.T) {
	t.Parallel()
	long, longValue, short, shortValue := secrets(t)
	var got http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		// An API that answers what it was sent, as some do.
		_ = json.NewEncoder(w).Encode(map[string]any{"echo": r.Header.Get("X-Code"), "pin": r.Header.Get("X-Pin"), "from_input": r.Header.Get("X-Input")})
	}))
	defer srv.Close()
	w := saveWorkflow(t, srv.URL, `{
	  "nodes": [{"id": "crm", "kind": "http", "request": {
	    "method": "GET", "url": "BASE/v1/{{ $const.`+long+` }}",
	    "headers": {"X-Code": "{{ $const.`+long+` }}", "X-Pin": "{{ $const.`+short+` }}", "X-Input": "{{ input.token }}"}}}],
	  "output": "nodes.crm.body"
	}`)
	var logs bytes.Buffer
	r := New(db, upstream.New(upstream.Options{AllowPrivateNetworks: true}), slog.New(slog.NewTextHandler(&logs, nil)), Options{})
	t.Cleanup(r.Stop)
	out, err := r.Serve(t.Context(), w.Slug, "", json.RawMessage(`{"token": "`+longValue+`"}`))
	if err != nil || out.Answer != 200 {
		t.Fatalf("Serve() = %+v, %v", out, err)
	}
	if got.Get("X-Code") != longValue || got.Get("X-Pin") != shortValue || got.Get("X-Input") != longValue {
		t.Errorf("the API got %v; want each value as it is", got)
	}
	want := `{"echo":"[secret ` + long + `]","from_input":"[secret ` + long + `]","pin":"[secret ` + short + `]"}`
	if string(out.Output) != want {
		t.Errorf("answered %s, want %s", out.Output, want)
	}
	events, err := json.Marshal(collect(t, r, out.Run.ID))
	if err != nil {
		t.Fatal(err)
	}
	kept := left(t, out.Run.ID)
	for what, text := range map[string]string{"the answer": string(out.Output), "the records": kept, "the events": string(events), "the logs": logs.String()} {
		if strings.Contains(text, longValue) || strings.Contains(text, `"`+shortValue+`"`) {
			t.Errorf("%s hold a secret: %s", what, text)
		}
	}
	if !strings.Contains(kept, "[secret "+long+"]") {
		t.Errorf("the records don't name the secret: %s", kept)
	}
}

// An archived secret is out of use, and a run that meets its value still
// doesn't keep it (plan 15).
func TestRun_MasksArchivedSecrets(t *testing.T) {
	t.Parallel()
	long, longValue, _, _ := secrets(t)
	if _, err := db.ArchiveConstant(t.Context(), long, store.Provenance{Actor: "token"}); err != nil {
		t.Fatal(err)
	}
	w := saveWorkflow(t, "", `{"nodes": [{"id": "echo", "kind": "transform", "expr": "input.token"}], "output": "nodes.echo.body"}`)
	r := New(db, upstream.New(upstream.Options{AllowPrivateNetworks: true}), slog.New(slog.DiscardHandler), Options{})
	t.Cleanup(r.Stop)
	out, err := r.Serve(t.Context(), w.Slug, "", json.RawMessage(`{"token": "`+longValue+`"}`))
	if err != nil || out.Answer != 200 {
		t.Fatalf("Serve() = %+v, %v", out, err)
	}
	if want := `"[secret ` + long + `]"`; string(out.Output) != want {
		t.Errorf("answered %s, want %s", out.Output, want)
	}
	if kept := left(t, out.Run.ID); strings.Contains(kept, longValue) {
		t.Errorf("the records hold the secret: %s", kept)
	}
}

// A secret in why a run failed is masked too: in the failure it records
// and answers, and in an error body that fails on its own, logged.
func TestRun_MasksSecretsInFailures(t *testing.T) {
	t.Parallel()
	long, longValue, _, _ := secrets(t)
	w := saveWorkflow(t, "", `{
	  "nodes": [{"id": "boom", "kind": "transform", "expr": "$error('no luck with ' & $const.`+long+`)"}],
	  "response": {"answers": [{"status": 200, "lines": [{"from": "boom"}]}],
	               "errors": {"body": "$error('nor with ' & $const.`+long+`)"}}
	}`)
	var logs bytes.Buffer
	r := New(db, upstream.New(upstream.Options{AllowPrivateNetworks: true}), slog.New(slog.NewTextHandler(&logs, nil)), Options{})
	t.Cleanup(r.Stop)
	out, err := r.Serve(context.WithoutCancel(t.Context()), w.Slug, "", nil)
	if err != nil {
		t.Fatalf("Serve() = %+v, %v", out, err)
	}
	failure, err := json.Marshal(out.Failure)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(failure), "[secret "+long+"]") {
		t.Errorf("the failure doesn't name the secret: %s", failure)
	}
	for what, text := range map[string]string{"the failure": string(failure), "the records": left(t, out.Run.ID), "the logs": logs.String()} {
		if strings.Contains(text, longValue) {
			t.Errorf("%s hold the secret: %s", what, text)
		}
	}

	// An answer that passes the failure on, from its Unhandled, with an
	// error body that fails as well: the problem it answers, and the log
	// saying the body failed.
	caught := saveWorkflow(t, "", `{
	  "nodes": [{"id": "boom", "kind": "transform", "expr": "$error('no luck with ' & $const.`+long+`)"}],
	  "response": {"answers": [{"status": 502, "lines": [{"from": "boom", "unhandled": true}]}],
	               "errors": {"body": "$error('nor with ' & $const.`+long+`)"}}
	}`)
	logs.Reset()
	out, err = r.Serve(context.WithoutCancel(t.Context()), caught.Slug, "", nil)
	if err != nil || out.Problem == nil {
		t.Fatalf("Serve() = %+v, %v; want a problem passed on", out, err)
	}
	problem, err := json.Marshal(out.Problem)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(problem), "[secret "+long+"]") || !strings.Contains(logs.String(), "an error body failed") {
		t.Errorf("the problem %s, or the log %s, doesn't name the secret", problem, logs.String())
	}
	for what, text := range map[string]string{"the problem": string(problem), "the records": left(t, out.Run.ID), "the logs": logs.String()} {
		if strings.Contains(text, longValue) {
			t.Errorf("%s hold the secret: %s", what, text)
		}
	}
}
