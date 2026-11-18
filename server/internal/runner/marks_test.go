package runner

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Beasr1/conduit/server/internal/store"
)

const (
	eid   = "784199012345671"
	name  = "Fatima Al Mansoori"
	phone = "+971501234567"
)

// crmUpstream is an API that finds a customer by Emirates ID, and answers
// with their name and phones, and the ID it was asked for, as some do.
func crmUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"asked":    strings.TrimPrefix(r.URL.Path, "/customers/"),
			"customer": map[string]any{"name": name, "contacts": []any{map[string]any{"phone": phone}, map[string]any{"phone": json.Number("971501234567")}}},
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// makeUpstream stores versions of an upstream, BASE standing for base in
// each, and gives back its id.
func makeUpstream(t *testing.T, base string, versions ...string) string {
	t.Helper()
	ctx, p := t.Context(), store.Provenance{Actor: "token"}
	u, _, err := db.CreateUpstream(ctx, slug(t), json.RawMessage(strings.ReplaceAll(versions[0], "BASE", base)), p)
	if err != nil {
		t.Fatal(err)
	}
	for i, v := range versions[1:] {
		if _, err := db.SaveUpstreamVersion(ctx, u.ID, i+1, json.RawMessage(strings.ReplaceAll(v, "BASE", base)), p); err != nil {
			t.Fatal(err)
		}
	}
	return u.ID
}

// A value an upstream marks, a parameter or a response field, is kept
// masked in every copy a run keeps, by the upstream's newest version's
// marks, though the step pins one with none: in what the step sent and got,
// in the next step's value, and in what was kept before the step met the
// value, the run's input and the step before, which are masked again as
// the run ends. The caller gets every value as it is (plan 17).
func TestRun_MasksWhatAnUpstreamMarks(t *testing.T) {
	t.Parallel()
	crm := crmUpstream(t)
	const v1 = `{"parameters": [{"name": "eid"}], "request": {"method": "GET", "url": "BASE/customers/{{ eid }}"}}`
	id := makeUpstream(t, crm.URL, v1, `{"parameters": [{"name": "eid", "mask": {"end": 4}}], "request": {"method": "GET", "url": "BASE/customers/{{ eid }}"},
	  "masked": [{"field": "customer.name", "mask": {}}, {"field": "customer.contacts.phone", "mask": {"start": 4}}]}`)
	w := saveWorkflow(t, "", `{"nodes": [
	    {"id": "first", "kind": "transform", "expr": "input", "unhandled": {"fail": true}},
	    {"id": "crm", "kind": "http", "uses": {"upstream": "`+id+`", "version": 1}, "with": {"eid": "input.eid"}, "unhandled": {"fail": true}},
	    {"id": "card", "kind": "transform", "expr": "{ 'name': nodes.crm.body.customer.name, 'eid': input.eid, 'phones': nodes.crm.body.customer.contacts.phone }", "unhandled": {"fail": true}}],
	  "edges": [{"from": "first", "to": "crm"}, {"from": "crm", "to": "card"}],
	  "response": {"answers": [{"status": 200, "lines": [{"from": "card"}]}]}}`)
	r := newRunner(t, Options{})
	out, err := r.Serve(t.Context(), w.Slug, "", json.RawMessage(`{"eid": "`+eid+`", "note": "for `+name+`"}`))
	if err != nil || out.Answer != 200 {
		t.Fatalf("Serve() = %+v, %v", out, err)
	}
	if want := `{"name":"` + name + `","eid":"` + eid + `","phones":["` + phone + `",971501234567]}`; string(out.Output) != want {
		t.Errorf("answered %s, want %s", out.Output, want)
	}
	kept := left(t, out.Run.ID)
	for _, v := range []string{eid, name, phone, "971501234567"} {
		if strings.Contains(kept, v) {
			t.Errorf("the records hold %s: %s", v, kept)
		}
	}
	for _, v := range []string{"/customers/***********5671", "***********5671", "for ******************", "+971*********", `"9715********"`} {
		if !strings.Contains(kept, v) {
			t.Errorf("the records don't hold %s: %s", v, kept)
		}
	}
}

// A workflow's input fields are masked as the run begins, a number kept
// as a string of its stars, and the caller gets them as they are (plan 17).
func TestRun_MasksWhatTheInputMarks(t *testing.T) {
	t.Parallel()
	w := saveWorkflow(t, "", `{"nodes": [{"id": "echo", "kind": "transform", "expr": "input", "unhandled": {"fail": true}}],
	  "masked_input": [{"field": "customer.eid", "mask": {"start": 3}}, {"field": "customer.name", "mask": {}}],
	  "response": {"answers": [{"status": 200, "lines": [{"from": "echo"}]}]}}`)
	r := newRunner(t, Options{})
	in := `{"customer": {"eid": 784199012345671, "name": "` + name + `"}, "other": "kept"}`
	out, err := r.Serve(t.Context(), w.Slug, "", json.RawMessage(in))
	if err != nil || out.Answer != 200 {
		t.Fatalf("Serve() = %+v, %v", out, err)
	}
	if want := `{"customer":{"eid":784199012345671,"name":"` + name + `"},"other":"kept"}`; string(out.Output) != want {
		t.Errorf("answered %s, want %s", out.Output, want)
	}
	full, err := db.Run(t.Context(), out.Run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"other": "kept", "customer": {"eid": "784************", "name": "******************"}}`; string(full.Input) != want {
		t.Errorf("kept input %s, want %s", full.Input, want)
	}
	if kept := left(t, out.Run.ID); strings.Contains(kept, eid) || strings.Contains(kept, name) {
		t.Errorf("the records hold a marked value: %s", kept)
	}
}

// A run of a workflow a step uses masks what its input marks, and hands it
// to its caller's run, which masks it too: in the input it kept first and
// in the answer the step got (plan 17).
func TestRun_AWorkflowAStepUsesHandsBackWhatItMasks(t *testing.T) {
	t.Parallel()
	card := saveWorkflow(t, "", `{"nodes": [{"id": "hi", "kind": "transform", "expr": "{ 'eid': input.eid }", "unhandled": {"fail": true}}],
	  "masked_input": [{"field": "eid", "mask": {"end": 4}}], "input_schema": {"type": "object", "properties": {"eid": {"type": "string"}}},
	  "response": {"answers": [{"status": 200, "lines": [{"from": "hi"}]}]}}`)
	caller := saveWorkflow(t, "", `{"nodes": [
	    {"id": "card", "kind": "http", "uses": {"workflow": "`+card.ID+`", "revision": 1}, "with": {"eid": "input.id"}, "unhandled": {"fail": true}}],
	  "response": {"answers": [{"status": 200, "lines": [{"from": "card"}]}]}}`)
	r := newRunner(t, Options{})
	out, err := r.Serve(t.Context(), caller.Slug, "", json.RawMessage(`{"id": "`+eid+`"}`))
	if err != nil || out.Answer != 200 || string(out.Output) != `{"eid":"`+eid+`"}` {
		t.Fatalf("Serve() = %+v %s, %v", out, out.Output, err)
	}
	runs, err := db.Runs(t.Context(), card.ID, 10, "")
	if err != nil || len(runs) != 1 {
		t.Fatalf("card's runs = %+v, %v", runs, err)
	}
	for _, id := range []string{out.Run.ID, runs[0].ID} {
		kept := left(t, id)
		if strings.Contains(kept, eid) || !strings.Contains(kept, "***********5671") {
			t.Errorf("run %s kept %s", id, kept)
		}
	}
}
