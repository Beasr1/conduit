package httpapi

import (
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Beasr1/conduit/server/internal/runner"
	"github.com/Beasr1/conduit/server/internal/store"
)

// signIn trades the test token for a session cookie, as the web app does.
func signIn(t *testing.T) *http.Cookie {
	t.Helper()
	r := call(t, http.MethodPost, "/v1/session", `{"token": "`+testToken+`"}`, "Authorization", "")
	if r.status != http.StatusNoContent {
		t.Fatalf("sign in = %d %s", r.status, r.body)
	}
	c, err := http.ParseSetCookie(r.header.Get("Set-Cookie"))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// withCookie sends a request with only a session cookie of this value, and
// headers in name, value pairs.
func withCookie(t *testing.T, value, method, path, body string, headers ...string) reply {
	t.Helper()
	return call(t, method, path, body, append([]string{"Authorization", "", "Cookie", sessionCookie + "=" + value}, headers...)...)
}

// startedAgo is the cookie of a session signed in d ago, and not used since.
func startedAgo(t *testing.T, d time.Duration) string {
	t.Helper()
	s := newSessions(testToken, db)
	s.now = func() time.Time { return time.Now().Add(-d) }
	c, err := s.start(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	return c.Value
}

func TestSession_SignInSetsAStrictCookie(t *testing.T) {
	t.Parallel()
	c := signIn(t)
	if c.Name != "__Host-conduit_session" || !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode ||
		c.Path != "/" || c.MaxAge != 12*60*60 || c.Domain != "" {
		t.Errorf("cookie = %+v", c)
	}
}

func TestSession_Refusals(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, body string
		status     int
		code       string
	}{
		{"a wrong token", `{"token": "nope"}`, 401, "unauthorized"},
		{"an unknown field", `{"token": "x", "remember": true}`, 422, "invalid_request"},
		{"no body", ``, 400, "invalid_json"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			r := call(t, http.MethodPost, "/v1/session", tt.body, "Authorization", "")
			if p := problemOf(t, r); r.status != tt.status || p.Code != tt.code {
				t.Errorf("got %d %s, want %d %s", r.status, p.Code, tt.status, tt.code)
			}
			if r.header.Get("Set-Cookie") != "" {
				t.Errorf("a refused sign-in set a cookie: %s", r.header.Get("Set-Cookie"))
			}
		})
	}
}

func TestSession_CookieAuthenticates(t *testing.T) {
	t.Parallel()
	c := signIn(t)
	for range 2 {
		if r := withCookie(t, c.Value, http.MethodGet, "/v1/workflows", ""); r.status != http.StatusOK {
			t.Errorf("a read with the cookie = %d %s", r.status, r.body)
		}
	}

	// Cookies the server didn't mint, or for sessions it doesn't have, are
	// refused.
	minted := newSessions(testToken, db)
	unrecorded := rand.Text()
	id, _, _ := strings.Cut(c.Value, ".")
	other, err := newSessions("another-token-0123456789abcdef0123456789", db).start(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	for name, bad := range map[string]string{
		"tampered with":      "x" + c.Value[1:], // another id, the same MAC
		"without its MAC":    id,
		"from another token": other.Value,
		"never recorded":     unrecorded + "." + minted.mac(unrecorded),
		"gone idle":          startedAgo(t, sessionIdle+time.Minute),
	} {
		if r := withCookie(t, bad, http.MethodGet, "/v1/workflows", ""); r.status != http.StatusUnauthorized {
			t.Errorf("a cookie %s = %d", name, r.status)
		}
	}
	if r := withCookie(t, startedAgo(t, sessionIdle-time.Minute), http.MethodGet, "/v1/workflows", ""); r.status != http.StatusOK {
		t.Errorf("a cookie a minute from going idle = %d %s", r.status, r.body)
	}
}

// A session lives while it's used within its idle time, and ends at its
// expiry however busy it is.
func TestSession_UseKeepsItLiveUntilItExpires(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	s := newSessions(testToken, db)
	signedIn := time.Now()
	clock := signedIn
	s.now = func() time.Time { return clock }
	c, err := s.start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	id, ok := s.id(c.Value)
	if !ok {
		t.Fatalf("the server's own cookie %q isn't its", c.Value)
	}
	step := sessionIdle - time.Minute
	for range sessionLife / step {
		clock = clock.Add(step)
		if live, err := s.live(ctx, id); !live || err != nil {
			t.Fatalf("used %v after sign-in: live %v, %v", clock.Sub(signedIn), live, err)
		}
	}
	clock = clock.Add(step)
	if live, err := s.live(ctx, id); live || err != nil {
		t.Errorf("used %v after sign-in: live %v, %v; want it expired", clock.Sub(signedIn), live, err)
	}
}

// Signing out ends the session on the server: a copy of the cookie stops
// working. Signing out with no session, or a bad one, still clears the
// cookie.
func TestSession_SignOutEndsTheSession(t *testing.T) {
	t.Parallel()
	c := signIn(t)
	for _, value := range []string{c.Value, "", "not-a-session"} {
		headers := []string{"Authorization", ""}
		if value != "" {
			headers = append(headers, "Cookie", sessionCookie+"="+value)
		}
		r := call(t, http.MethodDelete, "/v1/session", "", headers...)
		cleared, err := http.ParseSetCookie(r.header.Get("Set-Cookie"))
		if r.status != http.StatusNoContent || err != nil || cleared.Name != sessionCookie || cleared.MaxAge >= 0 || cleared.Value != "" {
			t.Errorf("sign out with %q = %d, cookie %+v, %v", value, r.status, cleared, err)
		}
	}
	if r := withCookie(t, c.Value, http.MethodGet, "/v1/workflows", ""); r.status != http.StatusUnauthorized {
		t.Errorf("a read with a signed-out cookie = %d", r.status)
	}
}

// A change made with the cookie has to come from the app's own pages.
func TestSession_WritesNeedTheSameOrigin(t *testing.T) {
	t.Parallel()
	c := signIn(t)
	create := func(site string) reply {
		t.Helper()
		body := `{"slug": "` + newSlug(t) + `", "name": "From the app", "definition": {"nodes": []}}`
		if site == "" {
			return withCookie(t, c.Value, http.MethodPost, "/v1/workflows", body)
		}
		return withCookie(t, c.Value, http.MethodPost, "/v1/workflows", body, "Sec-Fetch-Site", site)
	}
	if r := create("same-origin"); r.status != http.StatusCreated {
		t.Errorf("same-origin write = %d %s", r.status, r.body)
	}
	for _, site := range []string{"same-site", "cross-site", "none", ""} {
		r := create(site)
		if p := problemOf(t, r); r.status != http.StatusForbidden || p.Code != "cross_origin" {
			t.Errorf("write with Sec-Fetch-Site %q = %d %s", site, r.status, p.Code)
		}
	}
}

// A request with a header is judged by the header alone.
func TestSession_AWrongHeaderIsNotRescuedByTheCookie(t *testing.T) {
	t.Parallel()
	c := signIn(t)
	r := call(t, http.MethodGet, "/v1/workflows", "", "Authorization", "Bearer nope", "Cookie", c.Name+"="+c.Value)
	if r.status != http.StatusUnauthorized {
		t.Errorf("wrong bearer with a good cookie = %d", r.status)
	}
}

// With the database down, a session can't be started, checked or ended:
// each is a 500, not a 401 that would send the app to sign in again.
func TestSession_DatabaseDown(t *testing.T) {
	t.Parallel()
	closed, err := store.Open(t.Context(), dbURL)
	if err != nil {
		t.Fatal(err)
	}
	closed.Close()
	down := newRouter(closed, runner.Options{}, 0)
	c := signIn(t)
	for _, req := range []struct{ method, path, body string }{
		{http.MethodPost, "/v1/session", `{"token": "` + testToken + `"}`},
		{http.MethodGet, "/v1/workflows", ``},
		{http.MethodDelete, "/v1/session", ``},
	} {
		r := httptest.NewRequestWithContext(t.Context(), req.method, req.path, strings.NewReader(req.body))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(c)
		rec := httptest.NewRecorder()
		down.ServeHTTP(rec, r)
		if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"code":"internal_error"`) {
			t.Errorf("%s %s = %d %s", req.method, req.path, rec.Code, rec.Body)
		}
	}
}
