package store_test

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Beasr1/conduit/server/internal/store"
)

// mint is a new key, as the store keeps it: its first characters and its
// SHA-256. Random, so each call's own.
func mint(t *testing.T) store.NewKey {
	t.Helper()
	value := "cnd_" + rand.Text()
	h := sha256.Sum256([]byte(value))
	return store.NewKey{Prefix: value[:8], Hash: h[:]}
}

func makeKey(t *testing.T, w store.Workflow, name string) (store.CallerKey, store.NewKey) {
	t.Helper()
	k := mint(t)
	made, err := db.CreateKey(t.Context(), w.ID, name, k, person)
	if err != nil {
		t.Fatal(err)
	}
	return made, k
}

// serves reports whether the key with hash serves the workflow at slug.
func serves(t *testing.T, slug string, k store.NewKey) bool {
	t.Helper()
	_, err := db.ServingKey(t.Context(), slug, k.Hash)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		t.Fatal(err)
	}
	return err == nil
}

// A key serves its own workflow, by its hash, and no other (plan 07).
func TestKeys_ServeTheirWorkflowOnly(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	a, b := create(t), create(t)
	made, k := makeKey(t, a, "CRM sync")
	if made.Name != "CRM sync" || made.Prefix != k.Prefix || made.Status != "active" || made.WorkflowID != a.ID ||
		made.ExpiresAt != nil || made.RevokedAt != nil || made.LastUsedAt != nil || made.Provenance != person {
		t.Errorf("made %+v", made)
	}
	id, err := db.ServingKey(ctx, a.Slug, k.Hash)
	if err != nil || id != made.ID {
		t.Errorf("ServingKey(a) = %q, %v; want %s", id, err, made.ID)
	}
	if serves(t, b.Slug, k) {
		t.Error("a's key serves b")
	}
	if serves(t, "nothing-here", k) {
		t.Error("a's key serves a slug with no workflow")
	}
	if serves(t, a.Slug, mint(t)) {
		t.Error("a key never made serves a")
	}
}

// Rotating gives the caller a new key with the old one's name, and the old
// one an expiry: it works until then and not after. Rotated with none, it
// stops at once.
func TestKeys_RotatedWorksUntilItsExpiry(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	w := create(t)
	old, oldKey := makeKey(t, w, "Mobile app")
	newKey := mint(t)
	made, rotated, err := db.RotateKey(ctx, w.ID, old.ID, time.Hour, newKey, person)
	if err != nil {
		t.Fatal(err)
	}
	if made.Name != "Mobile app" || made.Prefix != newKey.Prefix || made.Status != "active" || made.ExpiresAt != nil || made.ID == old.ID {
		t.Errorf("new key %+v", made)
	}
	if rotated.ID != old.ID || rotated.Status != "expiring" || rotated.ExpiresAt == nil ||
		rotated.ExpiresAt.Sub(rotated.CreatedAt) < 59*time.Minute || rotated.ExpiresAt.Sub(rotated.CreatedAt) > 61*time.Minute {
		t.Errorf("old key %+v; want it expiring in an hour", rotated)
	}
	if !serves(t, w.Slug, oldKey) || !serves(t, w.Slug, newKey) {
		t.Error("within its hour, the old key or the new one doesn't serve")
	}

	// Its hour up.
	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `UPDATE caller_keys SET expires_at = now() - interval '1 second' WHERE id = $1::uuid`, old.ID); err != nil {
		t.Fatal(err)
	}
	if serves(t, w.Slug, oldKey) {
		t.Error("the old key serves past its expiry")
	}
	if !serves(t, w.Slug, newKey) {
		t.Error("the new key stopped with the old one")
	}

	// Rotated with no time to change over.
	nowKey := mint(t)
	again, stopped, err := db.RotateKey(ctx, w.ID, made.ID, 0, nowKey, person)
	if err != nil || stopped.Status != "expired" || again.Status != "active" {
		t.Fatalf("RotateKey(now) = %+v, %+v, %v", again, stopped, err)
	}
	if serves(t, w.Slug, newKey) || !serves(t, w.Slug, nowKey) {
		t.Error("rotated now, the old key serves, or the new one doesn't")
	}

	keys, err := db.Keys(ctx, w.ID)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, k := range keys {
		got = append(got, k.Status)
	}
	// Every key it has had, newest first.
	if len(keys) != 3 || keys[0].ID != again.ID || keys[1].ID != made.ID || keys[2].ID != old.ID {
		t.Errorf("Keys() = %v, %+v", got, keys)
	}
	if want := []string{"active", "expired", "expired"}; !slices.Equal(got, want) {
		t.Errorf("statuses = %v; want %v", got, want)
	}
}

// Only an active key is rotated, and only by its own workflow's id: one
// rotated or revoked already is refused, as two rotations at once are but
// one.
func TestKeys_OnlyAnActiveKeyRotates(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	w, other := create(t), create(t)
	key, _ := makeKey(t, w, "CRM sync")
	if _, _, err := db.RotateKey(ctx, other.ID, key.ID, time.Hour, mint(t), person); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("rotated through another workflow: %v; want ErrNotFound", err)
	}
	for _, id := range []string{"0190d2a5-0000-7000-8000-000000000000", "not-a-uuid"} {
		if _, _, err := db.RotateKey(ctx, w.ID, id, time.Hour, mint(t), person); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("RotateKey(%s) = %v; want ErrNotFound", id, err)
		}
	}

	var wg sync.WaitGroup
	news := []store.NewKey{mint(t), mint(t)}
	errs := make([]error, len(news))
	for i, k := range news {
		wg.Go(func() { _, _, errs[i] = db.RotateKey(ctx, w.ID, key.ID, time.Hour, k, person) })
	}
	wg.Wait()
	if (errs[0] == nil) == (errs[1] == nil) {
		t.Fatalf("two rotations at once: %v, %v; want one to succeed", errs[0], errs[1])
	}
	for _, err := range errs {
		if err != nil && !errors.Is(err, store.ErrKeyNotActive) {
			t.Errorf("the second rotation: %v; want ErrKeyNotActive", err)
		}
	}

	revoked, _ := makeKey(t, w, "Billing")
	if _, err := db.RevokeKey(ctx, w.ID, revoked.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := db.RotateKey(ctx, w.ID, revoked.ID, time.Hour, mint(t), person); !errors.Is(err, store.ErrKeyNotActive) {
		t.Errorf("rotated a revoked key: %v; want ErrKeyNotActive", err)
	}
}

// Revoking stops a key at once, and it stays listed. Revoking it again,
// or a key past its expiry, changes nothing.
func TestKeys_RevokedStopsAtOnce(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	w, other := create(t), create(t)
	key, k := makeKey(t, w, "CRM sync")
	if _, err := db.RevokeKey(ctx, other.ID, key.ID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("revoked through another workflow: %v; want ErrNotFound", err)
	}
	revoked, err := db.RevokeKey(ctx, w.ID, key.ID)
	if err != nil || revoked.Status != "revoked" || revoked.RevokedAt == nil {
		t.Fatalf("RevokeKey() = %+v, %v", revoked, err)
	}
	if serves(t, w.Slug, k) {
		t.Error("a revoked key serves")
	}
	again, err := db.RevokeKey(ctx, w.ID, key.ID)
	if err != nil || again.RevokedAt == nil || !again.RevokedAt.Equal(*revoked.RevokedAt) {
		t.Errorf("revoked again = %+v, %v; want it as it was", again, err)
	}

	gone, _ := makeKey(t, w, "Mobile app")
	if _, _, err := db.RotateKey(ctx, w.ID, gone.ID, 0, mint(t), person); err != nil {
		t.Fatal(err)
	}
	expired, err := db.RevokeKey(ctx, w.ID, gone.ID)
	if err != nil || expired.Status != "expired" || expired.RevokedAt != nil {
		t.Errorf("revoked past its expiry = %+v, %v; want it expired, as it was", expired, err)
	}

	keys, err := db.Keys(ctx, w.ID)
	if err != nil || len(keys) != 3 {
		t.Errorf("Keys() = %+v, %v; want the revoked key, the expired one and its new one", keys, err)
	}
}

// A workflow's active keys each have a name of their own. Another
// workflow's keys, and its own rotated or revoked ones, don't take it.
func TestKeys_ActiveKeysHaveNamesOfTheirOwn(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	w, other := create(t), create(t)
	key, _ := makeKey(t, w, "CRM sync")
	if _, err := db.CreateKey(ctx, w.ID, "CRM sync", mint(t), person); !errors.Is(err, store.ErrConflict) {
		t.Errorf("a second active CRM sync: %v; want ErrConflict", err)
	}
	makeKey(t, other, "CRM sync")
	if _, err := db.RevokeKey(ctx, w.ID, key.ID); err != nil {
		t.Fatal(err)
	}
	makeKey(t, w, "CRM sync")
}

// A served run records the key it was called with, which says who called
// by name; the key's last use is its latest run. A run's key is one of its
// own workflow's, and only a served run has one.
func TestKeys_ARunRecordsItsKey(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	w, other := create(t), create(t)
	key, _ := makeKey(t, w, "CRM sync")
	start := func(wf store.Workflow, trigger, keyID string) (store.Run, error) {
		return db.StartRun(ctx, store.NewRun{
			WorkflowID: wf.ID, Revision: 1, Trigger: trigger, TraceID: traceID, Key: keyID, Input: json.RawMessage(`{}`),
		})
	}
	first, err := start(w, "served", key.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := store.RunKey{ID: key.ID, Name: "CRM sync", Prefix: key.Prefix}
	if first.Key == nil || *first.Key != want {
		t.Errorf("StartRun().Key = %+v; want %+v", first.Key, want)
	}
	latest, err := start(w, "served", key.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := db.Run(ctx, latest.ID); err != nil || got.Key == nil || *got.Key != want {
		t.Errorf("Run().Key = %+v, %v", got.Key, err)
	}
	finished, err := db.FinishRun(ctx, latest.ID, "succeeded", 200, json.RawMessage(`{}`), false, nil)
	if err != nil || finished.Key == nil || *finished.Key != want {
		t.Errorf("FinishRun().Key = %+v, %v", finished.Key, err)
	}
	runs, err := db.Runs(ctx, w.ID, 10, "")
	if err != nil || len(runs) != 2 || runs[0].Key == nil || *runs[0].Key != want {
		t.Errorf("Runs() = %+v, %v", runs, err)
	}
	if editor := startRun(t, w); editor.Key != nil {
		t.Errorf("an editor run has a key: %+v", editor.Key)
	}

	keys, err := db.Keys(ctx, w.ID)
	if err != nil || len(keys) != 1 || keys[0].LastUsedAt == nil || !keys[0].LastUsedAt.Equal(latest.StartedAt) {
		t.Errorf("Keys() = %+v, %v; want last used at %v", keys, err, latest.StartedAt)
	}

	if _, err := start(other, "served", key.ID); err == nil {
		t.Error("a run of another workflow took the key")
	}
	if _, err := start(w, "editor", key.ID); err == nil {
		t.Error("an editor run took a key")
	}
}
