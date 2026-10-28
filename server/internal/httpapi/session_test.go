package httpapi

import (
	"net/http"
	"strings"
	"testing"
	"time"
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
	if r := withCookie(t, c.Value, http.MethodGet, "/v1/workflows", ""); r.status != http.StatusOK {
		t.Errorf("a read with the cookie = %d %s", r.status, r.body)
	}

	// Cookies the server didn't mint, or minted long enough ago, are refused.
	expired := newSessions(testToken)
	expired.now = func() time.Time { return time.Now().Add(-sessionLife - time.Minute) }
	for name, bad := range map[string]string{
		"expired":            expired.cookie().Value,
		"tampered with":      strings.Replace(c.Value, ".", "9.", 1), // a later expiry, the same MAC
		"from another token": newSessions("another-token-0123456789abcdef0123456789").cookie().Value,
	} {
		if r := withCookie(t, bad, http.MethodGet, "/v1/workflows", ""); r.status != http.StatusUnauthorized {
			t.Errorf("a cookie %s = %d", name, r.status)
		}
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

func TestSession_SignOutClearsTheCookie(t *testing.T) {
	t.Parallel()
	r := call(t, http.MethodDelete, "/v1/session", "", "Authorization", "")
	c, err := http.ParseSetCookie(r.header.Get("Set-Cookie"))
	if r.status != http.StatusNoContent || err != nil || c.Name != sessionCookie || c.MaxAge >= 0 || c.Value != "" {
		t.Errorf("sign out = %d, cookie %+v, %v", r.status, c, err)
	}
}
