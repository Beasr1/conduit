package httpapi

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
)

// caller is who a request acts for, and what it came from. v1 has one actor,
// the token's holder (D12). Plan 08 adds agents with their own scopes.
type caller struct {
	actor  string
	client string // the User-Agent, trimmed
}

type callerKey struct{}

func callerFrom(ctx context.Context) caller {
	c, _ := ctx.Value(callerKey{}).(caller)
	return c
}

// open lists the routes that need no credentials, the ones the spec marks
// `security: []`. Signing in and out are open: one checks the token itself,
// the other only clears a cookie.
var open = map[string]bool{
	"GET /healthz": true, "GET /readyz": true,
	"POST /v1/session": true, "DELETE /v1/session": true,
}

// credentials is what proves a request is the token's holder: the API token
// as a bearer token, or a session cookie it was traded for (plan 04).
type credentials struct {
	digest   [sha256.Size]byte // of the token
	sessions *sessions
}

func newCredentials(token string) credentials {
	return credentials{digest: sha256.Sum256([]byte(token)), sessions: newSessions(token)}
}

// tokenOK compares SHA-256 digests in constant time, so neither the token's
// bytes nor its length leak through timing.
func (c credentials) tokenOK(got string) bool {
	digest := sha256.Sum256([]byte(got))
	return subtle.ConstantTimeCompare(digest[:], c.digest[:]) == 1
}

// authenticate refuses a request without credentials. An Authorization
// header, when there is one, decides alone: a wrong token isn't rescued by
// a cookie.
func authenticate(c credentials) gen.MiddlewareFunc {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if open[r.Pattern] {
				next.ServeHTTP(w, r)
				return
			}
			switch header := r.Header.Get("Authorization"); {
			case header != "":
				// The scheme is case-insensitive (RFC 9110 §11.1).
				scheme, got, _ := strings.Cut(header, " ")
				if !strings.EqualFold(scheme, "Bearer") || !c.tokenOK(got) {
					unauthorized(w)
					return
				}
			case c.sessions.valid(r):
				// SameSite=Strict keeps the cookie off other sites' requests.
				// This keeps it off other origins' writes too, such as an app
				// on another port of the same host. A browser too old to send
				// Sec-Fetch-Site (before 2023) can't write with the cookie.
				if !safeMethod(r.Method) && r.Header.Get("Sec-Fetch-Site") != "same-origin" {
					writeProblem(w, &problem{
						status: http.StatusForbidden, code: "cross_origin",
						detail: "A change made with the session cookie has to come from the app's own pages.",
					})
					return
				}
			default:
				unauthorized(w)
				return
			}
			who := caller{actor: "token", client: truncate(r.UserAgent(), 200)}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), callerKey{}, who)))
		})
	}
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Bearer realm="conduit"`)
	writeProblem(w, &problem{
		status: http.StatusUnauthorized, code: "unauthorized",
		detail: "Send the API token as Authorization: Bearer <token>, or sign in.",
	})
}

func safeMethod(method string) bool {
	return method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions
}

// truncate cuts s to at most n bytes, dropping a character split at the cut.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "")
}
