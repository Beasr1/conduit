package store_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"

	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/store/storetest"
)

var (
	db    *store.Store
	dbURL string // the package's own database
)

func TestMain(m *testing.M) {
	os.Exit(storetest.Run(m, func(s *store.Store, url string) { db, dbURL = s, url }))
}

var person = store.Provenance{Actor: "token", Client: "test"}

// slug is unique per call, so parallel tests never collide.
func slug(t *testing.T) string {
	t.Helper()
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return "wf-" + hex.EncodeToString(b)
}

func def(n int) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"nodes": []any{}, "output": n})
	return b
}

func create(t *testing.T) store.Workflow {
	t.Helper()
	w, _, err := db.CreateWorkflow(t.Context(), slug(t), "Send to CRM", def(1), person)
	if err != nil {
		t.Fatal(err)
	}
	return w
}

func TestCreateWorkflow_StoresRevisionOne(t *testing.T) {
	t.Parallel()
	s := slug(t)
	w, r, err := db.CreateWorkflow(t.Context(), s, "Send to CRM", def(1), person)
	if err != nil {
		t.Fatal(err)
	}
	if w.Slug != s || w.LatestRevision != 1 || w.PublishedRevision != nil || len(w.ID) != 36 {
		t.Errorf("workflow = %+v", w)
	}
	if r.Revision != 1 || r.WorkflowID != w.ID || r.Provenance != person || string(r.Definition) != `{"nodes": [], "output": 1}` {
		t.Errorf("revision = %+v, definition %s", r, r.Definition)
	}
	got, err := db.Workflow(t.Context(), w.ID)
	if err != nil || got.ID != w.ID || !got.CreatedAt.Equal(w.CreatedAt) {
		t.Errorf("Workflow() = %+v, %v", got, err)
	}
}

func TestCreateWorkflow_RefusesATakenSlug(t *testing.T) {
	t.Parallel()
	s := slug(t)
	if _, _, err := db.CreateWorkflow(t.Context(), s, "a", def(1), person); err != nil {
		t.Fatal(err)
	}
	_, _, err := db.CreateWorkflow(t.Context(), s, "b", def(1), person)
	if !errors.Is(err, store.ErrConflict) {
		t.Errorf("second create error = %v, want ErrConflict", err)
	}
}

func TestWorkflow_NotFound(t *testing.T) {
	t.Parallel()
	for _, id := range []string{"0190d2a5-0000-7000-8000-000000000000", "not-a-uuid"} {
		if _, err := db.Workflow(t.Context(), id); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("Workflow(%q) error = %v, want ErrNotFound", id, err)
		}
	}
}

func TestSaveRevision(t *testing.T) {
	t.Parallel()
	w := create(t)
	r, err := db.SaveRevision(t.Context(), w.ID, 1, def(2), person)
	if err != nil || r.Revision != 2 {
		t.Fatalf("SaveRevision on 1 = %+v, %v; want revision 2", r, err)
	}
	if _, err := db.SaveRevision(t.Context(), w.ID, 1, def(3), person); !errors.Is(err, store.ErrRevisionMismatch) {
		t.Errorf("save on a stale base: error = %v, want ErrRevisionMismatch", err)
	}
	if _, err := db.SaveRevision(t.Context(), "0190d2a5-0000-7000-8000-000000000000", 1, def(3), person); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("save to a missing workflow: error = %v, want ErrNotFound", err)
	}
	got, err := db.Revision(t.Context(), w.ID, 2)
	if err != nil || string(got.Definition) != `{"nodes": [], "output": 2}` {
		t.Errorf("Revision(2) = %s, %v", got.Definition, err)
	}
	rs, err := db.Revisions(t.Context(), w.ID)
	if err != nil || len(rs) != 2 || rs[0].Revision != 2 || rs[1].Revision != 1 || rs[0].Definition != nil {
		t.Errorf("Revisions() = %+v, %v; want 2 then 1, without definitions", rs, err)
	}
}

func TestSaveRevision_ConcurrentSavesOnOneBase(t *testing.T) {
	t.Parallel()
	w := create(t)
	var wg sync.WaitGroup
	errs := make([]error, 8)
	for i := range errs {
		wg.Go(func() {
			_, errs[i] = db.SaveRevision(context.Background(), w.ID, 1, def(i), person)
		})
	}
	wg.Wait()
	won := 0
	for _, err := range errs {
		switch {
		case err == nil:
			won++
		case !errors.Is(err, store.ErrRevisionMismatch):
			t.Errorf("unexpected error: %v", err)
		}
	}
	if won != 1 {
		t.Errorf("%d saves on base 1 succeeded, want exactly 1", won)
	}
	if got, _ := db.Workflow(t.Context(), w.ID); got.LatestRevision != 2 {
		t.Errorf("latest revision = %d, want 2", got.LatestRevision)
	}
}

func TestPublish(t *testing.T) {
	t.Parallel()
	w := create(t)
	got, err := db.Publish(t.Context(), w.ID, 1)
	if err != nil || got.PublishedRevision == nil || *got.PublishedRevision != 1 {
		t.Fatalf("Publish(1) = %+v, %v", got, err)
	}
	if _, err := db.Publish(t.Context(), w.ID, 2); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("publish a revision that doesn't exist: error = %v, want ErrNotFound", err)
	}
}

func TestWorkflows_PagesNewestFirst(t *testing.T) {
	t.Parallel()
	// Other tests create workflows concurrently, so check order and the
	// cursor rather than exact contents.
	for range 3 {
		create(t)
	}
	first, err := db.Workflows(t.Context(), 2, "")
	if err != nil || len(first) != 2 {
		t.Fatalf("Workflows(2) = %d, %v", len(first), err)
	}
	if first[0].ID <= first[1].ID {
		t.Errorf("not newest first: %s then %s", first[0].ID, first[1].ID)
	}
	next, err := db.Workflows(t.Context(), 2, first[1].ID)
	if err != nil || len(next) == 0 || next[0].ID >= first[1].ID {
		t.Errorf("the page after %s = %+v, %v", first[1].ID, next, err)
	}
}
