package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"testing"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/store"
)

// newConstant is a name no other test's constant has.
func newConstant(t *testing.T) string {
	t.Helper()
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return "c_" + hex.EncodeToString(b)
}

// A secret constant's value goes in and never comes out (plan 06): not
// from making it, changing it, undoing it, or listing them all.
func TestConstants_SecretNeverSent(t *testing.T) {
	t.Parallel()
	name := newConstant(t)
	const first, second = "sk_live_first_0123456789", "sk_live_second_0123456789"
	r := call(t, http.MethodPost, "/v1/constants", `{"name": "`+name+`", "value": "`+first+`", "secret": true}`)
	if r.status != http.StatusCreated || r.header.Get("Location") != "/v1/constants/"+name {
		t.Fatalf("POST = %d %s, Location %q", r.status, r.body, r.header.Get("Location"))
	}
	if c := strict[gen.Constant](t, r.body); c.Name != name || !c.Secret || c.Value != "" || c.HasPrevious {
		t.Errorf("made %+v", c)
	}
	sent := []reply{r}
	r = call(t, http.MethodPut, "/v1/constants/"+name, `{"value": "`+second+`"}`)
	if c := strict[gen.Constant](t, r.body); r.status != http.StatusOK || !c.Secret || c.Value != "" || !c.HasPrevious {
		t.Errorf("PUT = %d %+v", r.status, c)
	}
	sent = append(sent, r)
	r = call(t, http.MethodPost, "/v1/constants/"+name+"/undo", "")
	if c := strict[gen.Constant](t, r.body); r.status != http.StatusOK || c.Value != "" || !c.HasPrevious {
		t.Errorf("undo = %d %+v", r.status, c)
	}
	sent = append(sent, r, call(t, http.MethodGet, "/v1/constants", ""))
	for _, r := range sent {
		for _, v := range []string{first, second, "sk_live"} {
			if strings.Contains(string(r.body), v) {
				t.Errorf("a response holds %q: %s", v, r.body)
			}
		}
	}
}

// A plain constant's value is shown, and a change keeps the one before.
func TestConstants_Plain(t *testing.T) {
	t.Parallel()
	name := newConstant(t)
	if r := call(t, http.MethodPost, "/v1/constants", `{"name": "`+name+`", "value": "https://a.example.com"}`); r.status != http.StatusCreated {
		t.Fatalf("POST = %d %s", r.status, r.body)
	}
	r := call(t, http.MethodPut, "/v1/constants/"+name, `{"value": "https://b.example.com"}`)
	if c := strict[gen.Constant](t, r.body); r.status != http.StatusOK || c.Value != "https://b.example.com" || c.Secret || !c.HasPrevious {
		t.Errorf("PUT = %d %+v", r.status, c)
	}
	r = call(t, http.MethodPost, "/v1/constants/"+name+"/undo", "")
	if c := strict[gen.Constant](t, r.body); r.status != http.StatusOK || c.Value != "https://a.example.com" {
		t.Errorf("undo = %d %+v", r.status, c)
	}
	list := strict[gen.ConstantList](t, call(t, http.MethodGet, "/v1/constants", "").body)
	found := false
	for _, c := range list.Constants {
		found = found || c.Name == name && c.Value == "https://a.example.com"
	}
	if !found {
		t.Errorf("the list lacks %s as undone: %+v", name, list)
	}
	// Made secret, it's shown no more.
	r = call(t, http.MethodPut, "/v1/constants/"+name, `{"value": "https://a.example.com", "secret": true}`)
	if c := strict[gen.Constant](t, r.body); r.status != http.StatusOK || !c.Secret || c.Value != "" {
		t.Errorf("made secret = %d %+v", r.status, c)
	}
}

func TestConstants_Refused(t *testing.T) {
	t.Parallel()
	name := newConstant(t)
	if r := call(t, http.MethodPost, "/v1/constants", `{"name": "`+name+`", "value": "v"}`); r.status != http.StatusCreated {
		t.Fatalf("POST = %d %s", r.status, r.body)
	}
	tests := []struct {
		label, method, path, body string
		status                    int
		code, pointer             string
	}{
		{"a name that isn't one", http.MethodPost, "/v1/constants", `{"name": "Crm-Token", "value": "v"}`, http.StatusUnprocessableEntity, "invalid_request", "/name"},
		{"no value", http.MethodPost, "/v1/constants", `{"name": "` + newConstant(t) + `", "value": ""}`, http.StatusUnprocessableEntity, "invalid_request", "/value"},
		{"a value too long", http.MethodPut, "/v1/constants/" + name, `{"value": "` + strings.Repeat("v", 4097) + `"}`, http.StatusUnprocessableEntity, "invalid_request", "/value"},
		{"a name taken", http.MethodPost, "/v1/constants", `{"name": "` + name + `", "value": "w"}`, http.StatusConflict, "conflict", ""},
		{"nothing to undo", http.MethodPost, "/v1/constants/" + name + "/undo", "", http.StatusConflict, "nothing_to_undo", ""},
		{"change one that isn't there", http.MethodPut, "/v1/constants/missing_one", `{"value": "v"}`, http.StatusNotFound, "not_found", ""},
		{"undo one that isn't there", http.MethodPost, "/v1/constants/missing_one/undo", "", http.StatusNotFound, "not_found", ""},
		{"delete one that isn't there", http.MethodDelete, "/v1/constants/missing_one", "", http.StatusNotFound, "not_found", ""},
		{"the users of one that isn't there", http.MethodGet, "/v1/constants/missing_one/users", "", http.StatusNotFound, "not_found", ""},
	}
	for _, tt := range tests {
		t.Run(tt.label, func(t *testing.T) {
			r := call(t, tt.method, tt.path, tt.body)
			p := problemOf(t, r)
			if r.status != tt.status || p.Code != tt.code {
				t.Fatalf("%s %s = %d %+v", tt.method, tt.path, r.status, p)
			}
			if tt.pointer != "" && (len(p.Errors) != 1 || p.Errors[0].Pointer != tt.pointer) {
				t.Errorf("errors = %+v, want one at %s", p.Errors, tt.pointer)
			}
		})
	}
	// Said of a constant, not of a workflow's slug.
	r := call(t, http.MethodPost, "/v1/constants", `{"name": "`+name+`", "value": "w"}`)
	if p := problemOf(t, r); p.Detail != "A constant already has that name." {
		t.Errorf("a name taken says %q", p.Detail)
	}
}

// A constant something reads stays: a saved revision, or an upstream's
// version, can run again (plan 06).
func TestConstants_Delete(t *testing.T) {
	t.Parallel()
	free := newConstant(t)
	call(t, http.MethodPost, "/v1/constants", `{"name": "`+free+`", "value": "v"}`)
	if r := call(t, http.MethodDelete, "/v1/constants/"+free, ""); r.status != http.StatusNoContent || len(r.body) != 0 {
		t.Errorf("DELETE = %d %s", r.status, r.body)
	}
	if r := call(t, http.MethodDelete, "/v1/constants/"+free, ""); r.status != http.StatusNotFound {
		t.Errorf("DELETE again = %d %s", r.status, r.body)
	}

	read := newConstant(t)
	call(t, http.MethodPost, "/v1/constants", `{"name": "`+read+`", "value": "v"}`)
	create(t, `{"nodes": [{"id": "crm", "kind": "http", "uses": {"upstream": "u", "version": 1}, "with": {"token": "$const.`+read+`"}}]}`)
	u := makeUpstream(t, `{"request": {"method": "GET", "url": "https://crm.example.com/v1", "headers": {"Authorization": "Bearer {{ $const.`+read+` }}"}}}`)
	r := call(t, http.MethodDelete, "/v1/constants/"+read, "")
	want := "Saved revisions or upstream versions read it, and each can run again: Send to CRM at revision 1; the upstream " + u.Upstream.Name + " at version 1."
	if p := problemOf(t, r); r.status != http.StatusConflict || p.Code != "constant_in_use" || p.Detail != want {
		t.Errorf("DELETE of one a revision reads = %d %+v, want %q", r.status, p, want)
	}

	users := strict[gen.ConstantUsers](t, call(t, http.MethodGet, "/v1/constants/"+read+"/users", "").body)
	if len(users.Workflows) != 1 || users.Workflows[0].Name != "Send to CRM" || users.Workflows[0].Revision != 1 ||
		len(users.Upstreams) != 1 || users.Upstreams[0].UpstreamID != u.Upstream.ID || users.Upstreams[0].Version != 1 {
		t.Errorf("users = %+v", users)
	}
}

func TestReadBy(t *testing.T) {
	t.Parallel()
	got := readBy(&store.ConstantInUseError{
		Workflows: []store.ConstantReader{{Name: "Orders", At: []int{2, 4}}, {Name: "Billing", At: []int{1}}},
		Upstreams: []store.ConstantReader{{Name: "CRM", At: []int{1, 2, 5}}},
	})
	if want := "Orders at revisions 2 and 4; Billing at revision 1; the upstream CRM at versions 1, 2 and 5"; got != want {
		t.Errorf("readBy() = %q, want %q", got, want)
	}
}

// A preview reads a plain constant's value, and a secret one's stand-in,
// never the secret (plan 06).
func TestPreview_Constants(t *testing.T) {
	t.Parallel()
	secret, base := newConstant(t), newConstant(t)
	const value = "sk_live_preview_0123456789"
	call(t, http.MethodPost, "/v1/constants", `{"name": "`+secret+`", "value": "`+value+`", "secret": true}`)
	call(t, http.MethodPost, "/v1/constants", `{"name": "`+base+`", "value": "tenant-a"}`)
	def := `{"nodes": [{"id": "crm", "kind": "http", "request": {"method": "POST", "url": "https://crm.example.com/{{ $const.` + base + ` }}/v1",
		"headers": {"X-Code": "{{ $const.` + secret + ` }}"}, "body": "{'token': $const.` + secret + `}"}}]}`
	r := call(t, http.MethodPost, "/v1/preview", `{"definition": `+def+`, "node": "crm"}`)
	pv := strict[gen.Preview](t, r.body)
	s := pv.Sends
	if r.status != http.StatusOK || s.URL != "https://crm.example.com/tenant-a/v1" || s.Headers["X-Code"] != "[secret "+secret+"]" ||
		string(s.Body) != `{"token":"[secret `+secret+`]"}` {
		t.Errorf("preview = %d %s", r.status, r.body)
	}
	if strings.Contains(string(r.body), value) {
		t.Errorf("the preview holds the secret: %s", r.body)
	}
}

// An upstream's version reads only constants there are: one that reads
// another isn't saved, as a step pins it (plan 07), and the library's
// check says where.
func TestUpstreams_UnknownConstant(t *testing.T) {
	t.Parallel()
	def := `{"request": {"method": "GET", "url": "https://crm.example.com/v1", "headers": {"X-Code": "{{ $const.no_such_one }}"}}}`
	r := call(t, http.MethodPost, "/v1/upstreams", `{"name": "CRM `+newSlug(t)+`", "definition": `+def+`}`)
	if p := problemOf(t, r); r.status != http.StatusUnprocessableEntity || len(p.Errors) != 1 ||
		p.Errors[0].Code != "unknown_constant" || p.Errors[0].Pointer != "/definition/request/headers/X-Code" {
		t.Errorf("POST = %d %+v", r.status, p)
	}
	v := strict[gen.Validation](t, call(t, http.MethodPost, "/v1/upstreams/validate", def).body)
	if len(v.Problems) != 1 || v.Problems[0].Code != "unknown_constant" {
		t.Errorf("validate = %+v", v.Problems)
	}
}

// The check says where an expression reads a constant that isn't there.
func TestValidate_UnknownConstant(t *testing.T) {
	t.Parallel()
	r := call(t, http.MethodPost, "/v1/validate", `{"nodes": [{"id": "pick", "kind": "transform", "expr": "$const.no_such_one"}]}`)
	v := strict[gen.Validation](t, r.body)
	found := false
	for _, p := range v.Problems {
		found = found || p.Pointer == "/nodes/0/expr" && p.Code == "unknown_constant"
	}
	if r.status != http.StatusOK || !found {
		t.Errorf("validate = %d %+v", r.status, v.Problems)
	}
}
