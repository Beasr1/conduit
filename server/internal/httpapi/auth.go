package httpapi

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/store"
)

// caller is who a request acts for, and what it came from. v1 has one actor,
// the token's holder (D12), and a served workflow's callers, each with a key
// of their own (plan 07). Plan 08 adds agents with their own scopes.
type caller struct {
	actor  string // token, or key
	client string // the User-Agent, trimmed
	key    string // the id of the caller key a /serve call came with; else empty
}

type callerKey struct{}

func callerFrom(ctx context.Context) caller {
	c, _ := ctx.Value(callerKey{}).(caller)
	return c
}

// open lists the routes that need no credentials, the ones the spec marks
// `security: []`. Signing in and out are open: one checks the token itself,
// the other ends whatever session its cookie names.
var open = map[string]bool{
	"GET /healthz": true, "GET /readyz": true,
	"POST /v1/session": true, "DELETE /v1/session": true,
}

// serveRoute is the one route a caller key opens (plan 07), and the only
// one the token doesn't.
const serveRoute = "POST /serve/{slug}"

// credentials is what proves a request is the token's holder: the API token
// as a bearer token, or a session cookie it was traded for (plan 04); and
// what proves a /serve call is one of the workflow's callers: one of its
// keys (plan 07).
type credentials struct {
	digest   [sha256.Size]byte // of the token
	sessions *sessions
	store    *store.Store
}

func newCredentials(token string, s *store.Store) credentials {
	return credentials{digest: sha256.Sum256([]byte(token)), sessions: newSessions(token, s), store: s}
}

// tokenOK compares SHA-256 digests in constant time, so neither the token's
// bytes nor its length leak through timing.
func (c credentials) tokenOK(got string) bool {
	digest := sha256.Sum256([]byte(got))
	return subtle.ConstantTimeCompare(digest[:], c.digest[:]) == 1
}

// authenticate refuses a request without credentials. A /serve call takes
// a key of its workflow and nothing else. Elsewhere, an Authorization
// header, when there is one, decides alone: a wrong token isn't rescued by
// a cookie. fail answers a key or a session the database couldn't check.
func authenticate(c credentials, fail func(http.ResponseWriter, *http.Request, error)) gen.MiddlewareFunc {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if open[r.Pattern] {
				next.ServeHTTP(w, r)
				return
			}
			if r.Pattern == serveRoute {
				key, ok := c.servingKey(w, r, fail)
				if !ok {
					return
				}
				who := caller{actor: "key", client: truncate(r.UserAgent(), 200), key: key}
				next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), callerKey{}, who)))
				return
			}
			if header := r.Header.Get("Authorization"); header != "" {
				// The scheme is case-insensitive (RFC 9110 §11.1).
				scheme, got, _ := strings.Cut(header, " ")
				if !strings.EqualFold(scheme, "Bearer") || !c.tokenOK(got) {
					refuse(w, r, apiRefused)
					return
				}
			} else if !c.session(w, r, fail) {
				return
			}
			who := caller{actor: "token", client: truncate(r.UserAgent(), 200)}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), callerKey{}, who)))
		})
	}
}

// servingKey is the id of the caller key r comes with as its bearer token,
// if it's a key of the workflow r's slug names that works, answering r
// itself when it isn't: with the same 401 whatever the reason, so the answer
// doesn't say which keys or workflows there are.
func (c credentials) servingKey(w http.ResponseWriter, r *http.Request, fail func(http.ResponseWriter, *http.Request, error)) (string, bool) {
	scheme, got, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	if !strings.EqualFold(scheme, "Bearer") || !strings.HasPrefix(got, keyPrefix) {
		refuse(w, r, keyRefused)
		return "", false
	}
	id, err := c.store.ServingKey(r.Context(), r.PathValue("slug"), hashOf(got))
	if errors.Is(err, store.ErrNotFound) {
		refuse(w, r, keyRefused)
		return "", false
	}
	if err != nil {
		fail(w, r, err)
		return "", false
	}
	return id, true
}

// session reports whether r comes with a live session's cookie, answering
// r itself when it doesn't. A cookie the server didn't mint, or a write
// from another origin, is refused before the database is asked.
func (c credentials) session(w http.ResponseWriter, r *http.Request, fail func(http.ResponseWriter, *http.Request, error)) bool {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil {
		refuse(w, r, apiRefused)
		return false
	}
	id, ok := c.sessions.id(cookie.Value)
	if !ok {
		refuse(w, r, apiRefused)
		return false
	}
	// SameSite=Strict keeps the cookie off other sites' requests. This keeps
	// it off other origins' writes too, such as an app on another port of the
	// same host. A browser too old to send Sec-Fetch-Site (before 2023) can't
	// write with the cookie.
	if !safeMethod(r.Method) && r.Header.Get("Sec-Fetch-Site") != "same-origin" {
		writeProblem(w, &problem{
			status: http.StatusForbidden, code: "cross_origin",
			detail: "A change made with the session cookie has to come from the app's own pages.",
		})
		return false
	}
	live, err := c.sessions.live(r.Context(), id)
	if err != nil {
		fail(w, r, err)
		return false
	}
	if !live {
		refuse(w, r, apiRefused)
	}
	return live
}

// What a refusal tells the caller to send.
const (
	apiRefused = "Send the API token as Authorization: Bearer <token>, or sign in."
	keyRefused = "Send a caller key of this workflow, one not revoked or past its expiry, as Authorization: Bearer <key>."
)

// refuse answers 401 with a Bearer challenge. A request that sent a bearer
// token is told it was refused, error="invalid_token", and one that sent
// none isn't, as RFC 6750 §3 asks; every refused token gets the same
// answer, so it doesn't say which are real.
func refuse(w http.ResponseWriter, r *http.Request, detail string) {
	challenge := `Bearer realm="conduit"`
	if scheme, _, _ := strings.Cut(r.Header.Get("Authorization"), " "); strings.EqualFold(scheme, "Bearer") {
		challenge += `, error="invalid_token"`
	}
	w.Header().Set("WWW-Authenticate", challenge)
	writeProblem(w, &problem{status: http.StatusUnauthorized, code: "unauthorized", detail: detail})
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
