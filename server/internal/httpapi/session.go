package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
)

const (
	// The __Host- prefix makes browsers refuse the cookie unless it's Secure,
	// with Path=/ and no Domain, so no other host can set it.
	sessionCookie = "__Host-conduit_session"
	sessionLife   = 12 * time.Hour
)

// sessions mints and checks the web app's session cookies. A cookie holds
// its expiry and an HMAC of it, so nothing is stored. The key comes from the
// API token, so changing the token ends every session.
type sessions struct {
	key []byte
	now func() time.Time
}

func newSessions(token string) *sessions {
	m := hmac.New(sha256.New, []byte(token))
	m.Write([]byte("conduit session"))
	return &sessions{key: m.Sum(nil), now: time.Now}
}

// cookie is a new session, good for sessionLife.
func (s *sessions) cookie() *http.Cookie {
	expiry := strconv.FormatInt(s.now().Add(sessionLife).Unix(), 10)
	return &http.Cookie{
		Name:     sessionCookie,
		Value:    expiry + "." + s.mac(expiry),
		Path:     "/",
		MaxAge:   int(sessionLife / time.Second),
		HttpOnly: true, // out of reach of the page's scripts
		Secure:   true,
		SameSite: http.SameSiteStrictMode, // never sent on another site's requests
	}
}

// valid reports whether r carries a session cookie that this server minted
// and that hasn't expired.
func (s *sessions) valid(r *http.Request) bool {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return false
	}
	expiry, mac, ok := strings.Cut(c.Value, ".")
	if !ok {
		return false
	}
	unix, err := strconv.ParseInt(expiry, 10, 64)
	if err != nil || s.now().Unix() >= unix {
		return false
	}
	return hmac.Equal([]byte(mac), []byte(s.mac(expiry)))
}

func (s *sessions) mac(expiry string) string {
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte(expiry))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (a *api) CreateSession(_ context.Context, req gen.CreateSessionRequestObject) (gen.CreateSessionResponseObject, error) {
	if !a.creds.tokenOK(req.Body.Token) {
		return nil, &problem{status: http.StatusUnauthorized, code: "unauthorized", detail: "That isn't the API token."}
	}
	return gen.CreateSession204Response{
		Headers: gen.CreateSession204ResponseHeaders{SetCookie: a.creds.sessions.cookie().String()},
	}, nil
}

// DeleteSession clears the cookie. It needs no session, so signing out
// always works.
func (*api) DeleteSession(context.Context, gen.DeleteSessionRequestObject) (gen.DeleteSessionResponseObject, error) {
	cleared := &http.Cookie{
		Name: sessionCookie, Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
	}
	return gen.DeleteSession204Response{
		Headers: gen.DeleteSession204ResponseHeaders{SetCookie: cleared.String()},
	}, nil
}
