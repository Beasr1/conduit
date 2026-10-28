package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/runner"
	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/store/storetest"
	"github.com/Beasr1/conduit/server/internal/upstream"
)

const testToken = "test-token-0123456789abcdef0123456789abcdef"

var (
	db     *store.Store
	router http.Handler
)

func TestMain(m *testing.M) {
	os.Exit(storetest.Run(m, func(s *store.Store, _ string) {
		db, router = s, newRouter(s, runner.Options{}, 0)
	}))
}

// newRouter's runs reach httptest upstreams, which listen on loopback.
// maxStreams 0 means the default.
func newRouter(s *store.Store, o runner.Options, maxStreams int) http.Handler {
	log := slog.New(slog.DiscardHandler)
	runs := runner.New(s, upstream.New(upstream.Options{AllowPrivateNetworks: true}), log, o)
	return NewRouter(Deps{Store: s, Runner: runs, Token: testToken, Log: log, MaxStreams: maxStreams})
}

// reply is what came back. A struct of its own rather than *http.Response,
// whose Body would need closing at every call site.
type reply struct {
	status int
	header http.Header
	body   []byte
}

// call sends a request through the router, with the token unless headers
// set Authorization themselves. headers alternate name, value.
func call(t *testing.T, method, path, body string, headers ...string) reply {
	t.Helper()
	req := httptest.NewRequestWithContext(t.Context(), method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+testToken)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	b, err := io.ReadAll(rec.Body)
	if err != nil {
		t.Fatal(err)
	}
	return reply{status: rec.Code, header: rec.Header(), body: b}
}

// problemOf decodes a problem-details body, failing on anything else.
func problemOf(t *testing.T, r reply) gen.Problem {
	t.Helper()
	if ct := r.header.Get("Content-Type"); ct != "application/problem+json" {
		t.Fatalf("Content-Type = %q, want application/problem+json; body %s", ct, r.body)
	}
	var p gen.Problem
	if err := json.Unmarshal(r.body, &p); err != nil {
		t.Fatalf("decode problem: %v; body %s", err, r.body)
	}
	return p
}

func TestHealthz(t *testing.T) {
	t.Parallel()
	r := call(t, http.MethodGet, "/healthz", "", "Authorization", "")
	if r.status != http.StatusOK || string(r.body) != `{"status":"ok"}`+"\n" {
		t.Errorf("GET /healthz = %d %s", r.status, r.body)
	}
}

func TestHealthz_WrongMethodIs405(t *testing.T) {
	t.Parallel()
	r := call(t, http.MethodPost, "/healthz", "")
	if r.status != http.StatusMethodNotAllowed || r.header.Get("Allow") != "GET, HEAD" {
		t.Errorf("POST /healthz = %d, Allow %q", r.status, r.header.Get("Allow"))
	}
}

func TestReadyz_NeedsNoToken(t *testing.T) {
	t.Parallel()
	r := call(t, http.MethodGet, "/readyz", "", "Authorization", "")
	if r.status != http.StatusOK {
		t.Errorf("GET /readyz = %d %s", r.status, r.body)
	}
}

func TestToken(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, auth string
		want       int
	}{
		{"missing", "", http.StatusUnauthorized},
		{"wrong", "Bearer nope", http.StatusUnauthorized},
		{"right token, wrong scheme", "Basic " + testToken, http.StatusUnauthorized},
		{"right", "Bearer " + testToken, http.StatusOK},
		{"the scheme is case-insensitive", "bearer " + testToken, http.StatusOK},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			r := call(t, http.MethodGet, "/v1/workflows", "", "Authorization", tt.auth)
			if r.status != tt.want {
				t.Fatalf("status = %d, want %d; body %s", r.status, tt.want, r.body)
			}
			if tt.want == http.StatusUnauthorized {
				if p := problemOf(t, r); p.Code != "unauthorized" || r.header.Get("WWW-Authenticate") == "" {
					t.Errorf("problem %+v, WWW-Authenticate %q", p, r.header.Get("WWW-Authenticate"))
				}
			}
		})
	}
}
