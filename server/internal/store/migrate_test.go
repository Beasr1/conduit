package store_test

import (
	"bytes"
	"strings"
	"testing"

	"github.com/Beasr1/conduit/server/internal/store"
)

// storetest has already migrated the database, so up has nothing left, and
// status lists every migration as applied. down isn't run: other tests in
// this package share the database.
func TestMigrate(t *testing.T) {
	url := dbURL
	var out bytes.Buffer
	if err := store.Migrate(t.Context(), url, "up", &out); err != nil || !strings.Contains(out.String(), "nothing to apply") {
		t.Errorf("up: %q, %v; want nothing to apply", out.String(), err)
	}
	out.Reset()
	if err := store.Migrate(t.Context(), url, "status", &out); err != nil || !strings.Contains(out.String(), "applied") ||
		!strings.Contains(out.String(), "20261026120000_workflows.sql") {
		t.Errorf("status: %q, %v", out.String(), err)
	}
	if err := store.Migrate(t.Context(), url, "sideways", &out); err == nil {
		t.Error("an unknown command succeeded")
	}
	if err := store.Migrate(t.Context(), "postgres://%zz", "up", &out); err == nil {
		t.Error("an unparsable url succeeded")
	}
}
