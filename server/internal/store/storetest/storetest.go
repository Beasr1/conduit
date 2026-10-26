// Package storetest gives a test package a fresh, migrated database of its
// own on the compose Postgres, dropped when the package's tests end.
//
// It reads the environment itself, from the setup settings in the repo's
// .env: CONDUIT_TEST_ADMIN_URL, a superuser connection that creates and drops
// the database, and CONDUIT_TEST_DATABASE_URL, whose role owns it and runs
// the tests, as the server's role would.
package storetest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/url"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Beasr1/conduit/server/internal/store"
)

// Run creates the database, hands use a Store connected to it and its URL,
// runs the tests and drops the database. Call it from TestMain:
//
//	func TestMain(m *testing.M) { os.Exit(storetest.Run(m, func(s *store.Store, _ string) { db = s })) }
//
// Without a database it fails instead of skipping: a skipped test still
// reads as green.
func Run(m *testing.M, use func(s *store.Store, databaseURL string)) int {
	ctx := context.Background()
	adminURL, appURL := os.Getenv("CONDUIT_TEST_ADMIN_URL"), os.Getenv("CONDUIT_TEST_DATABASE_URL")
	if adminURL == "" || appURL == "" {
		fmt.Fprintln(os.Stderr, "storetest: CONDUIT_TEST_ADMIN_URL and CONDUIT_TEST_DATABASE_URL must be set; `just setup` writes them to .env, `just test` loads it, and `just db-up` starts the database")
		return 1
	}
	u, err := url.Parse(appURL)
	if err != nil || u.User == nil {
		fmt.Fprintln(os.Stderr, "storetest: CONDUIT_TEST_DATABASE_URL must name a user")
		return 1
	}

	suffix := make([]byte, 6)
	if _, err := rand.Read(suffix); err != nil {
		fmt.Fprintln(os.Stderr, "storetest:", err)
		return 1
	}
	name := "conduit_test_" + hex.EncodeToString(suffix)
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "storetest: connect as admin (is `just db-up` running?):", err)
		return 1
	}
	defer admin.Close(ctx)
	ident := pgx.Identifier{name}.Sanitize()
	owner := pgx.Identifier{u.User.Username()}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+ident+" OWNER "+owner); err != nil {
		fmt.Fprintln(os.Stderr, "storetest: create database:", err)
		return 1
	}
	defer func() {
		if _, err := admin.Exec(ctx, "DROP DATABASE "+ident+" WITH (FORCE)"); err != nil {
			fmt.Fprintln(os.Stderr, "storetest: drop database:", err)
		}
	}()

	u.Path = "/" + name
	if err := store.Migrate(ctx, u.String(), "up", io.Discard); err != nil {
		fmt.Fprintln(os.Stderr, "storetest:", err)
		return 1
	}
	s, err := store.Open(ctx, u.String())
	if err != nil {
		fmt.Fprintln(os.Stderr, "storetest:", err)
		return 1
	}
	defer s.Close()
	use(s, u.String())
	return m.Run()
}
