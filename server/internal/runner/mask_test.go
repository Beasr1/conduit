package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/upstream"
	"github.com/Beasr1/conduit/server/internal/workflow"
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

// A mask keeps the characters it's asked to, a star for each one it hides,
// and always hides at least half, its start giving way first (plan 17).
func TestStars(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		value string
		mask  workflow.Mask
		want  string
	}{
		{"784199012345671", workflow.Mask{}, "***************"},
		{"784199012345671", workflow.Mask{End: 4}, "***********5671"},
		{"4111111111111111", workflow.Mask{Start: 6}, "411111**********"},
		{"4111111111111111", workflow.Mask{Start: 6, End: 4}, "4111********1111"},
		{"4111111111111111", workflow.Mask{Start: 2, End: 2}, "41************11"},
		{"abcd", workflow.Mask{Start: 3}, "ab**"},
		{"abc", workflow.Mask{End: 8}, "**c"},
		{"x", workflow.Mask{End: 4}, "*"},
		{"فاطمة", workflow.Mask{End: 2}, "***مة"},
	} {
		if got := stars(tt.value, tt.mask); got != tt.want {
			t.Errorf("stars(%q, %+v) = %q, want %q", tt.value, tt.mask, got, tt.want)
		}
	}
}

// A field's values are what an expression reading it gives, over each item
// of an array, every string and number inside one that holds more; an
// empty string, a boolean or null is nothing to mask (plan 17).
func TestValuesAt(t *testing.T) {
	t.Parallel()
	doc := []byte(`{"customer": {"emirates_id": "784199012345671", "contacts": [{"phone": "+971501234567"}, {"phone": 971501234567}, {"email": "a@b.example"}],
	  "empty": "", "verified": true, "none": null}}`)
	for _, tt := range []struct {
		doc  []byte
		path []string
		want []string
	}{
		{doc, []string{"customer", "emirates_id"}, []string{"784199012345671"}},
		{doc, []string{"customer", "contacts", "phone"}, []string{"+971501234567", "971501234567"}},
		{doc, []string{"customer", "contacts"}, []string{"+971501234567", "971501234567", "a@b.example"}},
		{doc, []string{"customer", "empty"}, nil},
		{doc, []string{"customer", "verified"}, nil},
		{doc, []string{"missing", "x"}, nil},
		{[]byte(`[{"id": "a"}, {"id": "b"}, [{"id": "c"}]]`), []string{"id"}, []string{"a", "b", "c"}},
		{[]byte(`not json`), []string{"id"}, nil},
	} {
		if got := valuesAt(decodeDoc(tt.doc), tt.path); !slices.Equal(got, tt.want) {
			t.Errorf("valuesAt(%s, %q) = %q, want %q", tt.doc, tt.path, got, tt.want)
		}
	}
}

// A marked value is masked wherever a copy of it is: in a string, whole or
// inside text, escaped in a URL, as JSON escapes it, or as a number; a
// short one only where it's all of a string or a number. The caller's answer
// keeps it (plan 17).
func TestMasker_Marked(t *testing.T) {
	t.Parallel()
	m := newMasker([]store.Constant{{Name: "tok", Secret: true, Value: "sk_live_0123456789"}})
	if m.count() != 0 {
		t.Fatalf("count() = %d before anything is marked", m.count())
	}
	m.add(workflow.Mask{}, "784199012345671")
	m.add(workflow.Mask{End: 4}, "784199012345671") // the same value: the mask that hides more wins
	m.add(workflow.Mask{End: 4}, "784199012345672")
	m.add(workflow.Mask{}, "Fatima Al Mansoori", "F", "فاطمة الزهراء")
	m.add(workflow.Mask{Start: 4}, "971501234567")
	if m.count() != 6 {
		t.Errorf("count() = %d, want 6", m.count())
	}
	// As an API that escapes all but ASCII writes it.
	ar := strconv.QuoteToASCII("فاطمة الزهراء")
	if !strings.HasPrefix(ar, `"\`) {
		t.Fatalf("QuoteToASCII() = %s, want it escaped", ar)
	}
	doc := `{"a": "784199012345671", "b": "784199012345672", "url": "/c?eid=784199012345672&n=Fatima+Al+Mansoori", "path": "/c/Fatima%20Al%20Mansoori",
	  "n": 971501234567, "s": "call 971501234567", "g": "F", "word": "Fine F", "seven": 7,
	  "ar": ` + ar + `, "tok": "sk_live_0123456789", "html": "<b>"}`
	want := `{"a":"***************","ar":"*************","b":"***********5672","g":"*","html":"<b>","n":"9715********","path":"/c/******************",` +
		`"s":"call 9715********","seven":7,"tok":"[secret tok]","url":"/c?eid=***********5672&n=******************","word":"Fine F"}`
	got := m.json([]byte(doc))
	if string(got) != want {
		t.Errorf("json() =\n%s\nwant\n%s", got, want)
	}
	if !json.Valid(got) {
		t.Errorf("masked JSON isn't JSON: %s", got)
	}
	for in, want := range map[string]string{
		"eid 784199012345672 for Fatima Al Mansoori": "eid ***********5672 for ******************",
		"F":            "*",
		"Fine F":       "Fine F",
		"971501234567": "9715********",
	} {
		if got := m.text(in); got != want {
			t.Errorf("text(%q) = %q, want %q", in, got, want)
		}
	}
	if got := string(m.answer([]byte(`{"a":"784199012345671","tok":"sk_live_0123456789"}`))); got != `{"a":"784199012345671","tok":"[secret tok]"}` {
		t.Errorf("answer() = %s; want the marked value kept and the secret masked", got)
	}
	if got := string(m.json([]byte(`not json 784199012345671`))); got != `not json 784199012345671` {
		t.Errorf("json() of what isn't JSON = %s; want it as it was", got)
	}
}
