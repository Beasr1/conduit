package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"strings"
	"time"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/store"
)

const (
	// The __Host- prefix makes browsers refuse the cookie unless it's Secure,
	// with Path=/ and no Domain, so no other host can set it.
	sessionCookie = "__Host-conduit_session"
	// A session ends this long after sign-in, however busy it is,
	sessionLife = 12 * time.Hour
	// or this long after its last request, whichever comes first.
	sessionIdle = 30 * time.Minute
)

// sessions mints and checks the web app's session cookies. A cookie holds a
// random id and an HMAC of it; the store keeps the id's SHA-256, when it was
// last used and when it expires, so signing out ends it on the server too.
// The HMAC's key comes from the API token, so changing the token ends every
// session, and a cookie the server didn't mint never reaches the database.
type sessions struct {
	key   []byte
	store *store.Store
	now   func() time.Time
}

func newSessions(token string, s *store.Store) *sessions {
	m := hmac.New(sha256.New, []byte(token))
	m.Write([]byte("conduit session"))
	return &sessions{key: m.Sum(nil), store: s, now: time.Now}
}

// start records a new session and returns its cookie, good for sessionLife.
func (s *sessions) start(ctx context.Context) (*http.Cookie, error) {
	id := rand.Text()
	now := s.now()
	if err := s.store.CreateSession(ctx, hashOf(id), now, now.Add(-sessionIdle), now.Add(sessionLife)); err != nil {
		return nil, err
	}
	return &http.Cookie{
		Name:     sessionCookie,
		Value:    id + "." + s.mac(id),
		Path:     "/",
		MaxAge:   int(sessionLife / time.Second),
		HttpOnly: true, // out of reach of the page's scripts
		Secure:   true,
		SameSite: http.SameSiteStrictMode, // never sent on another site's requests
	}, nil
}

// id is the session id in a cookie's value, if this server minted it.
func (s *sessions) id(value string) (string, bool) {
	id, mac, ok := strings.Cut(value, ".")
	if !ok || !hmac.Equal([]byte(mac), []byte(s.mac(id))) {
		return "", false
	}
	return id, true
}

// live reports whether the session is live, and if so marks it used now.
func (s *sessions) live(ctx context.Context, id string) (bool, error) {
	now := s.now()
	return s.store.TouchSession(ctx, hashOf(id), now, now.Add(-sessionIdle))
}

func (s *sessions) mac(id string) string {
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte(id))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// hashOf is what the store knows a session or a caller key by.
func hashOf(id string) []byte {
	h := sha256.Sum256([]byte(id))
	return h[:]
}

func (a *api) CreateSession(ctx context.Context, req gen.CreateSessionRequestObject) (gen.CreateSessionResponseObject, error) {
	if !a.creds.tokenOK(req.Body.Token) {
		return nil, &problem{status: http.StatusUnauthorized, code: "unauthorized", detail: "That isn't the API token."}
	}
	c, err := a.creds.sessions.start(ctx)
	if err != nil {
		return nil, err
	}
	return gen.CreateSession204Response{
		Headers: gen.CreateSession204ResponseHeaders{SetCookie: c.String()},
	}, nil
}

// DeleteSession ends the cookie's session and clears the cookie. It needs no
// live session, so signing out always works.
func (a *api) DeleteSession(ctx context.Context, req gen.DeleteSessionRequestObject) (gen.DeleteSessionResponseObject, error) {
	if id, ok := a.creds.sessions.id(req.Params.Session); ok {
		if err := a.store.DeleteSession(ctx, hashOf(id)); err != nil {
			return nil, err
		}
	}
	cleared := &http.Cookie{
		Name: sessionCookie, Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
	}
	return gen.DeleteSession204Response{
		Headers: gen.DeleteSession204ResponseHeaders{SetCookie: cleared.String()},
	}, nil
}
