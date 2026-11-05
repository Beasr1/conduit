package store_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Beasr1/conduit/server/internal/store"
)

// A constant's name is unique, so each test's own.
func constantName(t *testing.T) string {
	t.Helper()
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return "c_" + hex.EncodeToString(b)
}

// A constant keeps the value before its last change, which undo puts back,
// and undoing again puts the newer one back (plan 06). A change that
// changes nothing keeps both as they were.
func TestConstants_ChangeAndUndo(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	name := constantName(t)
	made, err := db.CreateConstant(ctx, name, "https://a.example.com", false, person)
	if err != nil {
		t.Fatal(err)
	}
	if made.Name != name || made.Value != "https://a.example.com" || made.Secret || made.HasPrevious || made.Provenance != person {
		t.Errorf("made %+v", made)
	}
	changed, err := db.SetConstant(ctx, name, "https://b.example.com", false, person)
	if err != nil || changed.Value != "https://b.example.com" || !changed.HasPrevious {
		t.Fatalf("SetConstant() = %+v, %v", changed, err)
	}
	same, err := db.SetConstant(ctx, name, "https://b.example.com", false, store.Provenance{Actor: "token", Client: "other"})
	if err != nil || same.Value != "https://b.example.com" || same.Provenance != person || !same.UpdatedAt.Equal(changed.UpdatedAt) {
		t.Errorf("a change that changes nothing = %+v, %v; want it as it was", same, err)
	}
	undone, err := db.UndoConstant(ctx, name, person)
	if err != nil || undone.Value != "https://a.example.com" || !undone.HasPrevious {
		t.Errorf("UndoConstant() = %+v, %v; want a's value back, b's kept", undone, err)
	}
	redone, err := db.UndoConstant(ctx, name, person)
	if err != nil || redone.Value != "https://b.example.com" {
		t.Errorf("UndoConstant() again = %+v, %v; want b's value back", redone, err)
	}
	got, err := db.Constant(ctx, name)
	if err != nil || got.Value != "https://b.example.com" {
		t.Errorf("Constant() = %+v, %v", got, err)
	}
	all, err := db.Constants(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range all {
		found = found || c.Name == name && c.Value == "https://b.example.com"
	}
	if !found {
		t.Errorf("Constants() lacks %s: %+v", name, all)
	}
}

// Making a constant secret is for good: there's no showing it again.
func TestConstants_SecretForGood(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	name := constantName(t)
	if _, err := db.CreateConstant(ctx, name, "plain", false, person); err != nil {
		t.Fatal(err)
	}
	c, err := db.SetConstant(ctx, name, "sk_live_0123456789", true, person)
	if err != nil || !c.Secret {
		t.Fatalf("made secret: %+v, %v", c, err)
	}
	c, err = db.SetConstant(ctx, name, "sk_live_9876543210", false, person)
	if err != nil || !c.Secret || c.Value != "sk_live_9876543210" {
		t.Errorf("changed with secret false: %+v, %v; want it still secret", c, err)
	}
	// Set to the value it has, and secret as it is, it's as it was.
	same, err := db.SetConstant(ctx, name, "sk_live_9876543210", true, store.Provenance{Actor: "token", Client: "other"})
	if err != nil || same.Provenance != person || !same.UpdatedAt.Equal(c.UpdatedAt) {
		t.Errorf("a change that changes nothing = %+v, %v; want it as it was", same, err)
	}

	// Made secret with its value as it was, it keeps the value before to go
	// back to.
	other := constantName(t)
	if _, err := db.CreateConstant(ctx, other, "a", false, person); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetConstant(ctx, other, "b", false, person); err != nil {
		t.Fatal(err)
	}
	if c, err := db.SetConstant(ctx, other, "b", true, person); err != nil || !c.Secret || c.Value != "b" {
		t.Fatalf("made secret only: %+v, %v", c, err)
	}
	if c, err := db.UndoConstant(ctx, other, person); err != nil || c.Value != "a" || !c.Secret {
		t.Errorf("undone after made secret: %+v, %v; want a, still secret", c, err)
	}
}

// Values are sealed in the database, and only the key they were sealed with
// opens them. Not parallel: it breaks a row, which would fail another
// test listing every constant, and takes it away before they run.
func TestConstants_Sealed(t *testing.T) {
	ctx := t.Context()
	name := constantName(t)
	if _, err := db.CreateConstant(ctx, name, "sk_live_0123456789", true, person); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetConstant(ctx, name, "sk_live_9876543210", true, person); err != nil {
		t.Fatal(err)
	}
	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var row []byte
	if err := conn.QueryRow(ctx, `SELECT row_to_json(c)::text FROM constants c WHERE name = $1`, name).Scan(&row); err != nil {
		t.Fatal(err)
	}
	for _, plain := range []string{"sk_live_0123456789", "sk_live_9876543210", "sk_live", "736b5f6c697665"} {
		if bytes.Contains(row, []byte(plain)) {
			t.Errorf("the row holds %q in the clear: %s", plain, row)
		}
	}

	// The name is sealed in with the value, so a value moved to another
	// constant doesn't open there.
	moved := constantName(t)
	if _, err := db.CreateConstant(ctx, moved, "another", true, person); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `UPDATE constants SET value = (SELECT value FROM constants WHERE name = $1) WHERE name = $2`, name, moved); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Constant(ctx, moved); err == nil {
		t.Error("a value moved to another constant opened there")
	}
	if _, err := conn.Exec(ctx, `DELETE FROM constants WHERE name = $1`, moved); err != nil {
		t.Fatal(err)
	}

	other := make([]byte, 32)
	if _, err := rand.Read(other); err != nil {
		t.Fatal(err)
	}
	s, err := store.Open(ctx, dbURL, other)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.Constant(ctx, name); err == nil {
		t.Error("another key opened the value")
	}
	if _, err := store.Open(ctx, dbURL, other[:16]); err == nil {
		t.Error("a 16-byte key was taken")
	}
}

func TestConstants_Refused(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	name := constantName(t)
	if _, err := db.CreateConstant(ctx, name, "v", false, person); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreateConstant(ctx, name, "w", false, person); !errors.Is(err, store.ErrConflict) {
		t.Errorf("a name taken: %v, want ErrConflict", err)
	}
	if _, err := db.UndoConstant(ctx, name, person); !errors.Is(err, store.ErrNothingToUndo) {
		t.Errorf("undo with nothing before: %v, want ErrNothingToUndo", err)
	}
	missing := constantName(t)
	if _, err := db.Constant(ctx, missing); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("Constant(missing) = %v, want ErrNotFound", err)
	}
	if _, err := db.SetConstant(ctx, missing, "v", false, person); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("SetConstant(missing) = %v, want ErrNotFound", err)
	}
	if _, err := db.UndoConstant(ctx, missing, person); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("UndoConstant(missing) = %v, want ErrNotFound", err)
	}
	if err := db.DeleteConstant(ctx, missing); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("DeleteConstant(missing) = %v, want ErrNotFound", err)
	}

	s, err := store.Open(ctx, dbURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.CreateConstant(ctx, constantName(t), "v", false, person); !errors.Is(err, store.ErrNoKey) {
		t.Errorf("a store with no key: %v, want ErrNoKey", err)
	}
}

// reads is a workflow definition with a step whose value reads $const.name.
func reads(name string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{
		"id": "crm", "kind": "http", "uses": map[string]any{"upstream": "u", "version": 1},
		"with": map[string]any{"token": "$const." + name},
	}}})
	return b
}

// readingUpstream is an upstream whose header reads $const.name.
func readingUpstream(name string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"request": map[string]any{
		"method": "GET", "url": "https://crm.example.com/v1",
		"headers": map[string]any{"Authorization": "Bearer {{ $const." + name + " }}"},
	}})
	return b
}

// A constant a saved revision or an upstream version reads can't be
// deleted: either can run again (plan 06), as a pinned upstream can't be
// (plan 07). One whose name merely starts another's is free to go.
func TestDeleteConstant(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	free, read, upstreamRead := constantName(t), constantName(t), constantName(t)
	for _, name := range []string{free, read, upstreamRead} {
		if _, err := db.CreateConstant(ctx, name, "v", false, person); err != nil {
			t.Fatal(err)
		}
	}
	// read_more is read, and read isn't: the name has to end where the
	// read does.
	w, _, err := db.CreateWorkflow(ctx, slug(t), "Reads", reads(free+"_more"), person)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SaveRevision(ctx, w.ID, 1, reads(read), person); err != nil {
		t.Fatal(err)
	}
	// Revision 3 reads it no more; revision 2 still does, and can run again.
	if _, err := db.SaveRevision(ctx, w.ID, 2, def(3), person); err != nil {
		t.Fatal(err)
	}
	u, _, err := db.CreateUpstream(ctx, upstreamName(t), readingUpstream(upstreamRead), person)
	if err != nil {
		t.Fatal(err)
	}

	var inUse *store.ConstantInUseError
	if err := db.DeleteConstant(ctx, read); !errors.As(err, &inUse) ||
		len(inUse.Workflows) != 1 || inUse.Workflows[0].ID != w.ID || inUse.Workflows[0].Name != "Reads" ||
		len(inUse.Workflows[0].At) != 1 || inUse.Workflows[0].At[0] != 2 || len(inUse.Upstreams) != 0 {
		t.Errorf("deleting one revision 2 reads: %v %+v", err, inUse)
	}
	if err := db.DeleteConstant(ctx, upstreamRead); !errors.As(err, &inUse) ||
		len(inUse.Upstreams) != 1 || inUse.Upstreams[0].ID != u.ID || inUse.Upstreams[0].At[0] != 1 || len(inUse.Workflows) != 0 {
		t.Errorf("deleting one an upstream reads: %v %+v", err, inUse)
	}
	if err := db.DeleteConstant(ctx, free); err != nil {
		t.Fatalf("deleting one nothing reads: %v", err)
	}
	if _, err := db.Constant(ctx, free); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("after delete: %v, want ErrNotFound", err)
	}
}

// A version saved reading the constant while it's deleted is seen: the
// delete waits for the save, then refuses.
func TestDeleteConstant_ASaveInBetween(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	name := constantName(t)
	if _, err := db.CreateConstant(ctx, name, "v", false, person); err != nil {
		t.Fatal(err)
	}
	u, _, err := db.CreateUpstream(ctx, upstreamName(t), upstreamDef(1), person)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// A save of a version that reads it, not yet committed.
	if _, err := tx.Exec(ctx, `INSERT INTO upstream_versions (upstream_id, version, definition, provenance)
		VALUES ($1::uuid, 2, $2, $3)`, u.ID, readingUpstream(name), person); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- db.DeleteConstant(context.Background(), name) }()
	// Once the delete waits for the save, the save commits.
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		var waiting int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM pg_locks
			WHERE NOT granted AND mode = 'ShareLock' AND relation = 'upstream_versions'::regclass`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the delete didn't wait for the save")
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var inUse *store.ConstantInUseError
	if err := <-done; !errors.As(err, &inUse) {
		t.Errorf("DeleteConstant() during a save that reads it = %v, want a ConstantInUseError", err)
	}
}

// Used by is the workflows whose latest revision reads a constant, and the
// upstreams whose latest version does.
func TestConstantUsers(t *testing.T) {
	t.Parallel()
	ctx := t.Context()
	name := constantName(t)
	if _, err := db.CreateConstant(ctx, name, "v", false, person); err != nil {
		t.Fatal(err)
	}
	reading, _, err := db.CreateWorkflow(ctx, slug(t), "Reading", reads(name), person)
	if err != nil {
		t.Fatal(err)
	}
	// Its latest revision reads it no more, so it isn't listed.
	stopped, _, err := db.CreateWorkflow(ctx, slug(t), "Stopped", reads(name), person)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SaveRevision(ctx, stopped.ID, 1, def(2), person); err != nil {
		t.Fatal(err)
	}
	u, _, err := db.CreateUpstream(ctx, upstreamName(t), readingUpstream(name), person)
	if err != nil {
		t.Fatal(err)
	}
	users, err := db.ConstantUsers(ctx, name)
	if err != nil {
		t.Fatal(err)
	}
	if len(users.Workflows) != 1 || users.Workflows[0].ID != reading.ID || users.Workflows[0].Name != "Reading" || users.Workflows[0].At[0] != 1 {
		t.Errorf("workflows = %+v", users.Workflows)
	}
	if len(users.Upstreams) != 1 || users.Upstreams[0].ID != u.ID || users.Upstreams[0].At[0] != 1 {
		t.Errorf("upstreams = %+v", users.Upstreams)
	}
	if _, err := db.ConstantUsers(ctx, constantName(t)); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("ConstantUsers(missing) = %v, want ErrNotFound", err)
	}
}
