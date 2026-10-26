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

// open lists the routes that need no token, the ones the spec marks
// `security: []`.
var open = map[string]bool{"GET /healthz": true, "GET /readyz": true}

// requireToken refuses a request without the bearer token. The comparison
// is of SHA-256 digests in constant time, so neither the token's bytes nor
// its length leak through timing.
func requireToken(token string) gen.MiddlewareFunc {
	want := sha256.Sum256([]byte(token))
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if open[r.Pattern] {
				next.ServeHTTP(w, r)
				return
			}
			// The scheme is case-insensitive (RFC 9110 §11.1).
			scheme, got, _ := strings.Cut(r.Header.Get("Authorization"), " ")
			digest := sha256.Sum256([]byte(got))
			if !strings.EqualFold(scheme, "Bearer") || subtle.ConstantTimeCompare(digest[:], want[:]) != 1 {
				w.Header().Set("WWW-Authenticate", `Bearer realm="conduit"`)
				writeProblem(w, &problem{
					status: http.StatusUnauthorized, code: "unauthorized",
					detail: "Send the API token as Authorization: Bearer <token>.",
				})
				return
			}
			c := caller{actor: "token", client: truncate(r.UserAgent(), 200)}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), callerKey{}, c)))
		})
	}
}

// truncate cuts s to at most n bytes, dropping a character split at the cut.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "")
}
