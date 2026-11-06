package httpapi

import (
	"bytes"
	"crypto/rand"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
)

// keyFor makes a caller key of the workflow through the API, and returns
// it, to send as a bearer token.
func keyFor(t *testing.T, workflowID string) string {
	t.Helper()
	return makeKey(t, workflowID, "caller "+rand.Text()[:6]).Value
}

func makeKey(t *testing.T, workflowID, name string) gen.MadeKey {
	t.Helper()
	r := call(t, http.MethodPost, "/v1/workflows/"+workflowID+"/keys", `{"name": "`+name+`"}`)
	if r.status != http.StatusCreated {
		t.Fatalf("make a key = %d %s", r.status, r.body)
	}
	return strict[gen.MadeKey](t, r.body)
}

// serveWith calls /serve/slug with key as its bearer token.
func serveWith(t *testing.T, slug, key, body string, headers ...string) reply {
	t.Helper()
	return call(t, http.MethodPost, "/serve/"+slug, body, append([]string{"Authorization", "Bearer " + key}, headers...)...)
}

// rotate rotates a key of a workflow, its old one working for grace.
func rotate(t *testing.T, workflowID, keyID, grace string) reply {
	t.Helper()
	return call(t, http.MethodPost, "/v1/workflows/"+workflowID+"/keys/"+keyID+"/rotate", `{"old_expires_in": "`+grace+`"}`)
}

// A key is cnd_ and 43 letters and digits: 256 random bits in base 62.
var keyShape = regexp.MustCompile(`^cnd_[0-9A-Za-z]{43}$`)

// What a refused /serve call is told, written out here so a change to it shows.
const serveRefused = "Send a caller key of this workflow, one not revoked or past its expiry, as Authorization: Bearer <key>."

// The challenges a 401 sends (RFC 6750 §3): with error="invalid_token" to a
// request that sent a bearer token, and plain to one that sent none.
const (
	challenge        = `Bearer realm="conduit"`
	refusedChallenge = `Bearer realm="conduit", error="invalid_token"`
)

// A key is its 32 random bytes as one number in base 62, padded to 43
// characters, which hold 256 bits: letters and digits only, so a
// double-click selects it whole. The values were worked out apart from the
// code, in Node.
func TestKeyOf(t *testing.T) {
	t.Parallel()
	counting := make([]byte, 32)
	for i := range counting {
		counting[i] = byte(i)
	}
	for _, tt := range []struct {
		name  string
		bytes []byte
		want  string
	}{
		{"no bit set", make([]byte, 32), "cnd_" + strings.Repeat("0", 43)},
		{"the bytes 0 to 31", counting, "cnd_003AuLtjc7TJLctqJ2Unu3mfAGcxg9lrkrCWgKbidLF"},
		{"every bit set", bytes.Repeat([]byte{0xff}, 32), "cnd_YHJSKWDa6oz1al1yMhwzwM8llg7hJNUca2J5RoW8xP1"},
	} {
		if got := keyOf(tt.bytes); got != tt.want {
			t.Errorf("%s: keyOf = %q, want %q", tt.name, got, tt.want)
		}
	}
	value, k := mintKey()
	if !keyShape.MatchString(value) || k.Prefix != value[:8] || !bytes.Equal(k.Hash, hashOf(value)) {
		t.Errorf("mintKey() = %q, %+v", value, k)
	}
	// Each carries all 256 bits: from fewer, every key would start with a 0.
	// From 256, one in about 60 does, so 20 all doing so is a once in 10^35.
	zeros := 0
	for range 20 {
		if v, _ := mintKey(); v[len(keyPrefix)] == '0' {
			zeros++
		}
	}
	if zeros == 20 {
		t.Error("20 keys all start with a 0: they hold fewer than 256 random bits")
	}
}

// /serve takes a key of the workflow it serves, and nothing else: another
// workflow's key, the API token, a session cookie, no credentials at all,
// and a slug with no workflow are each the same 401 (plan 07).
func TestKeys_ServeTheirWorkflowOnly(t *testing.T) {
	t.Parallel()
	base := usersUpstream(t).URL
	a := published(t, base, greetDef)
	b := published(t, base, greetDef)
	key, other := keyFor(t, a.Workflow.ID), keyFor(t, b.Workflow.ID)
	if r := serveWith(t, a.Workflow.Slug, key, `{"user_id": "7"}`); r.status != http.StatusOK {
		t.Fatalf("serve with its key = %d %s", r.status, r.body)
	}

	cookie := signIn(t)
	// A bearer token refused is told so, alike for every one; anything else
	// gets the plain challenge.
	for _, tt := range []struct {
		name      string
		slug      string
		headers   []string
		challenge string
	}{
		{"another workflow's key", a.Workflow.Slug, []string{"Authorization", "Bearer " + other}, refusedChallenge},
		{"the API token", a.Workflow.Slug, []string{"Authorization", "Bearer " + testToken}, refusedChallenge},
		{"a key never made", a.Workflow.Slug, []string{"Authorization", "Bearer cnd_" + strings.Repeat("A", 43)}, refusedChallenge},
		{"a slug with no workflow", "no-such-slug", []string{"Authorization", "Bearer " + key}, refusedChallenge},
		{"a key under another scheme", a.Workflow.Slug, []string{"Authorization", "Basic " + key}, challenge},
		{"the key alone", a.Workflow.Slug, []string{"Authorization", key}, challenge},
		{"a session cookie", a.Workflow.Slug, []string{"Authorization", "", "Cookie", cookie.Name + "=" + cookie.Value, "Sec-Fetch-Site", "same-origin"}, challenge},
		{"no credentials", a.Workflow.Slug, []string{"Authorization", ""}, challenge},
	} {
		r := call(t, http.MethodPost, "/serve/"+tt.slug, `{"user_id": "7"}`, tt.headers...)
		if p := problemOf(t, r); r.status != http.StatusUnauthorized || p.Code != "unauthorized" || p.Detail != serveRefused ||
			r.header.Get("WWW-Authenticate") != tt.challenge {
			t.Errorf("%s: %d %+v, WWW-Authenticate %q, want %q", tt.name, r.status, p, r.header.Get("WWW-Authenticate"), tt.challenge)
		}
	}

	// A key opens /serve only: the API is the token's.
	r := call(t, http.MethodGet, "/v1/workflows/"+a.Workflow.ID, "", "Authorization", "Bearer "+key)
	if r.status != http.StatusUnauthorized {
		t.Errorf("GET a workflow with a key = %d %s", r.status, r.body)
	}

	// A workflow not yet published says so, to a caller with its key.
	unpublished := create(t, validDef).Workflow
	r = serveWith(t, unpublished.Slug, keyFor(t, unpublished.ID), "")
	if p := problemOf(t, r); r.status != http.StatusNotFound || p.Code != "not_found" {
		t.Errorf("serve what isn't published = %d %+v", r.status, p)
	}
}

// A key is shown once, when it's made, and listed with no more of it than
// its first characters; a run it calls says so, and is its last use.
func TestKeys_MadeListedAndNamedByItsRuns(t *testing.T) {
	t.Parallel()
	wr := published(t, usersUpstream(t).URL, greetDef)
	id := wr.Workflow.ID
	made := makeKey(t, id, "CRM sync")
	if !keyShape.MatchString(made.Value) || made.Key.Prefix != made.Value[:8] || made.Key.Name != "CRM sync" ||
		made.Key.Status != gen.Active || made.Key.Provenance.Actor != "token" {
		t.Errorf("made %+v", made)
	}
	if again := makeKey(t, id, "Mobile app"); again.Value == made.Value || again.Key.Prefix == "" {
		t.Errorf("a second key = %+v", again)
	}

	r := serveWith(t, wr.Workflow.Slug, made.Value, `{"user_id": "7"}`)
	if r.status != http.StatusOK {
		t.Fatalf("serve = %d %s", r.status, r.body)
	}
	runs := strict[gen.RunList](t, call(t, http.MethodGet, "/v1/runs?workflow_id="+id, "").body).Runs
	want := gen.RunKey{ID: made.Key.ID, Name: "CRM sync", Prefix: made.Key.Prefix}
	if len(runs) != 1 || runs[0].Key != want {
		t.Fatalf("runs = %+v; want one, by %+v", runs, want)
	}
	if run := strict[gen.Run](t, call(t, http.MethodGet, "/v1/runs/"+runs[0].ID, "").body); run.Key != want {
		t.Errorf("the run's key = %+v; want %+v", run.Key, want)
	}

	r = call(t, http.MethodGet, "/v1/workflows/"+id+"/keys", "")
	if r.status != http.StatusOK || strings.Contains(string(r.body), made.Value) || strings.Contains(string(r.body), `"value"`) {
		t.Fatalf("list = %d %s; want no key's value", r.status, r.body)
	}
	keys := strict[gen.CallerKeyList](t, r.body).Keys
	if len(keys) != 2 || keys[0].Name != "Mobile app" || keys[1].ID != made.Key.ID {
		t.Fatalf("keys = %+v; want both, newest first", keys)
	}
	if !keys[1].LastUsedAt.Equal(runs[0].StartedAt) || !keys[0].LastUsedAt.IsZero() {
		t.Errorf("last used %v and %v; want %v, and never", keys[1].LastUsedAt, keys[0].LastUsedAt, runs[0].StartedAt)
	}
}

func TestKeys_Refusals(t *testing.T) {
	t.Parallel()
	id := create(t, validDef).Workflow.ID
	key := makeKey(t, id, "CRM sync").Key
	keys := "/v1/workflows/" + id + "/keys"
	for _, tt := range []struct {
		name, method, path, body string
		status                   int
		code, pointer            string
	}{
		{"no name", http.MethodPost, keys, `{"name": ""}`, 422, "invalid_request", "/name"},
		{"a name too long", http.MethodPost, keys, `{"name": "` + strings.Repeat("n", 201) + `"}`, 422, "invalid_request", "/name"},
		{"a name an active key has", http.MethodPost, keys, `{"name": "CRM sync"}`, 409, "conflict", ""},
		{"keys of no workflow", http.MethodGet, "/v1/workflows/0190d2a5-0000-7000-8000-000000000000/keys", "", 404, "not_found", ""},
		{"a key of no workflow", http.MethodPost, "/v1/workflows/0190d2a5-0000-7000-8000-000000000000/keys", `{"name": "x"}`, 404, "not_found", ""},
		{"an expiry it doesn't offer", http.MethodPost, keys + "/" + key.ID + "/rotate", `{"old_expires_in": "2d"}`, 422, "invalid_request", "/old_expires_in"},
		{"no expiry", http.MethodPost, keys + "/" + key.ID + "/rotate", `{}`, 422, "invalid_request", "/old_expires_in"},
		{"rotate no such key", http.MethodPost, keys + "/not-a-uuid/rotate", `{"old_expires_in": "1h"}`, 404, "not_found", ""},
		{"revoke no such key", http.MethodPost, keys + "/0190d2a5-0000-7000-8000-000000000000/revoke", "", 404, "not_found", ""},
	} {
		r := call(t, tt.method, tt.path, tt.body)
		if p := problemOf(t, r); r.status != tt.status || p.Code != tt.code || !strings.Contains(pointers(p), tt.pointer) {
			t.Errorf("%s: %d %+v", tt.name, r.status, p)
		}
	}
}

// Rotating gives the caller a new key, shown once, with the old one's name;
// the old one works until the expiry chosen, and not after. Only an active
// key rotates.
func TestKeys_Rotate(t *testing.T) {
	t.Parallel()
	wr := published(t, usersUpstream(t).URL, greetDef)
	id, slug := wr.Workflow.ID, wr.Workflow.Slug
	first := makeKey(t, id, "Mobile app")
	r := rotate(t, id, first.Key.ID, "1h")
	if r.status != http.StatusOK {
		t.Fatalf("rotate = %d %s", r.status, r.body)
	}
	second := strict[gen.RotatedKey](t, r.body)
	if !keyShape.MatchString(second.Value) || second.Key.Name != "Mobile app" || second.Key.Status != gen.Active ||
		second.Old.ID != first.Key.ID || second.Old.Status != gen.Expiring {
		t.Errorf("rotated %+v", second)
	}
	if left := second.Old.ExpiresAt.Sub(second.Old.CreatedAt); left < 59*time.Minute || left > 61*time.Minute {
		t.Errorf("the old key expires %v after it was made; want an hour", left)
	}
	for name, key := range map[string]string{"the old key": first.Value, "the new key": second.Value} {
		if r := serveWith(t, slug, key, `{"user_id": "7"}`); r.status != http.StatusOK {
			t.Errorf("%s, within its hour: %d %s", name, r.status, r.body)
		}
	}
	if r := rotate(t, id, first.Key.ID, "1h"); r.status != http.StatusConflict || problemOf(t, r).Code != "key_not_active" {
		t.Errorf("rotate the old key again = %d %s", r.status, r.body)
	}

	// Its hour up.
	conn, err := pgx.Connect(t.Context(), dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(t.Context())
	if _, err := conn.Exec(t.Context(), `UPDATE caller_keys SET expires_at = now() - interval '1 second' WHERE id = $1::uuid`, first.Key.ID); err != nil {
		t.Fatal(err)
	}
	if r := serveWith(t, slug, first.Value, `{"user_id": "7"}`); r.status != http.StatusUnauthorized {
		t.Errorf("the old key past its expiry = %d %s", r.status, r.body)
	}

	// Rotated now, the old one stops at once.
	r = rotate(t, id, second.Key.ID, "now")
	third := strict[gen.RotatedKey](t, r.body)
	if r.status != http.StatusOK || third.Old.Status != gen.Expired {
		t.Fatalf("rotate now = %d %s", r.status, r.body)
	}
	if r := serveWith(t, slug, second.Value, `{"user_id": "7"}`); r.status != http.StatusUnauthorized {
		t.Errorf("a key rotated now = %d %s", r.status, r.body)
	}
	if r := serveWith(t, slug, third.Value, `{"user_id": "7"}`); r.status != http.StatusOK {
		t.Errorf("its new key = %d %s", r.status, r.body)
	}

	// The days on offer.
	for grace, want := range map[string]time.Duration{"1d": 24 * time.Hour, "7d": 7 * 24 * time.Hour} {
		k := makeKey(t, id, "Billing "+grace)
		r := rotate(t, id, k.Key.ID, grace)
		if left := strict[gen.RotatedKey](t, r.body).Old.ExpiresAt.Sub(k.Key.CreatedAt); left < want-time.Minute || left > want+time.Minute {
			t.Errorf("%s: the old key expires %v after it was made; want %v", grace, left, want)
		}
	}
}

// Revoking stops a key at once; it stays listed, and revoking it again
// changes nothing.
func TestKeys_Revoke(t *testing.T) {
	t.Parallel()
	wr := published(t, usersUpstream(t).URL, greetDef)
	id := wr.Workflow.ID
	made := makeKey(t, id, "CRM sync")
	revoke := func() gen.CallerKey {
		t.Helper()
		r := call(t, http.MethodPost, "/v1/workflows/"+id+"/keys/"+made.Key.ID+"/revoke", "")
		if r.status != http.StatusOK {
			t.Fatalf("revoke = %d %s", r.status, r.body)
		}
		return strict[gen.CallerKey](t, r.body)
	}
	revoked := revoke()
	if revoked.Status != gen.Revoked || revoked.RevokedAt.IsZero() {
		t.Errorf("revoked %+v", revoked)
	}
	if r := serveWith(t, wr.Workflow.Slug, made.Value, `{"user_id": "7"}`); r.status != http.StatusUnauthorized {
		t.Errorf("serve with a revoked key = %d %s", r.status, r.body)
	}
	if again := revoke(); !again.RevokedAt.Equal(revoked.RevokedAt) {
		t.Errorf("revoked again at %v; want %v, as it was", again.RevokedAt, revoked.RevokedAt)
	}
	if r := rotate(t, id, made.Key.ID, "1h"); r.status != http.StatusConflict || problemOf(t, r).Code != "key_not_active" {
		t.Errorf("rotate a revoked key = %d %s", r.status, r.body)
	}
	keys := strict[gen.CallerKeyList](t, call(t, http.MethodGet, "/v1/workflows/"+id+"/keys", "").body).Keys
	if len(keys) != 1 || keys[0].Status != gen.Revoked {
		t.Errorf("keys = %+v; want the revoked one", keys)
	}
	// Its name is free again.
	makeKey(t, id, "CRM sync")
}
