package httpapi

import (
	"context"
	"crypto/rand"
	"errors"
	"math/big"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/store"
)

// Caller keys (plan 07): a workflow is served with keys of its own, one per
// caller, each minted here and shown once.

const (
	// keyPrefix marks a caller key as Conduit's wherever it's pasted.
	keyPrefix = "cnd_"
	// keyDigits is how many base 62 digits hold 256 bits: 43 × log₂ 62 is
	// about 256.03.
	keyDigits = 43
)

// mintKey makes a new key from 256 random bits, and what the store keeps
// of it: its first 8 characters, and its SHA-256. A slow hash is for what
// can be guessed, and 256 random bits leave nothing to.
func mintKey() (string, store.NewKey) {
	b := make([]byte, 32)
	_, _ = rand.Read(b) // crypto/rand's Read never fails
	value := keyOf(b)
	return value, store.NewKey{Prefix: value[:len(keyPrefix)+4], Hash: hashOf(value)}
}

// keyOf is the key 32 bytes make: cnd_, then the bytes as one number in
// base 62, padded to keyDigits. Letters and digits only, so a double-click
// selects the whole key, where base64url's '-' would stop it.
func keyOf(b []byte) string {
	n := new(big.Int).SetBytes(b).Text(62)
	return keyPrefix + strings.Repeat("0", keyDigits-len(n)) + n
}

// graces is how long a rotated key goes on working, by the name the API
// gives it.
var graces = map[gen.RotateKeyOldExpiresIn]time.Duration{
	gen.Now: 0, gen.N1H: time.Hour, gen.N1D: 24 * time.Hour, gen.N7D: 7 * 24 * time.Hour,
}

func (a *api) ListKeys(ctx context.Context, req gen.ListKeysRequestObject) (gen.ListKeysResponseObject, error) {
	if _, err := a.store.Workflow(ctx, req.ID); err != nil {
		return nil, err
	}
	keys, err := a.store.Keys(ctx, req.ID)
	if err != nil {
		return nil, err
	}
	out := gen.ListKeys200JSONResponse{Keys: make([]gen.CallerKey, 0, len(keys))}
	for _, k := range keys {
		out.Keys = append(out.Keys, keyOut(k))
	}
	return out, nil
}

func (a *api) CreateKey(ctx context.Context, req gen.CreateKeyRequestObject) (gen.CreateKeyResponseObject, error) {
	name := req.Body.Name
	if n := utf8.RuneCountInString(name); n < 1 || n > 200 {
		return nil, &problem{
			status: http.StatusUnprocessableEntity, code: "invalid_request",
			detail: "The request has problems; nothing was saved.",
			errors: []gen.ProblemError{{Pointer: "/name", Code: "invalid_name", Detail: "a name is 1 to 200 characters"}},
		}
	}
	value, k := mintKey()
	key, err := a.store.CreateKey(ctx, req.ID, name, k, provenance(ctx))
	if errors.Is(err, store.ErrConflict) {
		return nil, &problem{status: http.StatusConflict, code: "conflict", detail: "An active key of this workflow has that name."}
	}
	if err != nil {
		return nil, err
	}
	return gen.CreateKey201JSONResponse{Key: keyOut(key), Value: value}, nil
}

func (a *api) RotateKey(ctx context.Context, req gen.RotateKeyRequestObject) (gen.RotateKeyResponseObject, error) {
	grace, ok := graces[req.Body.OldExpiresIn]
	if !ok {
		return nil, &problem{
			status: http.StatusUnprocessableEntity, code: "invalid_request",
			detail: "The request has problems; nothing was saved.",
			errors: []gen.ProblemError{{Pointer: "/old_expires_in", Code: "invalid_expiry", Detail: "the old key goes on working now, 1h, 1d or 7d"}},
		}
	}
	value, k := mintKey()
	made, old, err := a.store.RotateKey(ctx, req.ID, req.Key, grace, k, provenance(ctx))
	if errors.Is(err, store.ErrKeyNotActive) {
		return nil, &problem{status: http.StatusConflict, code: "key_not_active", detail: "It was rotated or revoked already: only an active key is rotated."}
	}
	if err != nil {
		return nil, noKey(err)
	}
	return gen.RotateKey200JSONResponse{Key: keyOut(made), Value: value, Old: keyOut(old)}, nil
}

func (a *api) RevokeKey(ctx context.Context, req gen.RevokeKeyRequestObject) (gen.RevokeKeyResponseObject, error) {
	key, err := a.store.RevokeKey(ctx, req.ID, req.Key)
	if err != nil {
		return nil, noKey(err)
	}
	return gen.RevokeKey200JSONResponse(keyOut(key)), nil
}

func noKey(err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return &problem{status: http.StatusNotFound, code: "not_found", detail: "The workflow has no such key."}
	}
	return err
}

// keyOut is a key as the API sends it: never its value, which the store
// doesn't have.
func keyOut(k store.CallerKey) gen.CallerKey {
	out := gen.CallerKey{
		ID: k.ID, Name: k.Name, Prefix: k.Prefix, Status: gen.CallerKeyStatus(k.Status),
		Provenance: provenanceOut(k.Provenance), CreatedAt: k.CreatedAt.UTC(),
	}
	if k.ExpiresAt != nil {
		out.ExpiresAt = k.ExpiresAt.UTC()
	}
	if k.RevokedAt != nil {
		out.RevokedAt = k.RevokedAt.UTC()
	}
	if k.LastUsedAt != nil {
		out.LastUsedAt = k.LastUsedAt.UTC()
	}
	return out
}
