package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"

	_ "github.com/jackc/pgx/v5/stdlib" // registers the pgx driver goose uses
	"github.com/pressly/goose/v3"

	"github.com/Beasr1/conduit/server/migrations"
)

// Migrate runs a goose command against the database: "up" applies every
// pending migration, "down" undoes the latest, "status" lists them. It opens
// its own connection, without the session timeouts, because a migration may
// legitimately run longer than any query should.
func Migrate(ctx context.Context, databaseURL, command string, out io.Writer) error {
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return errors.New("migrate: the connection settings can't be parsed")
	}
	defer db.Close()
	p, err := goose.NewProvider(goose.DialectPostgres, db, migrations.FS)
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}

	switch command {
	case "up":
		results, err := p.Up(ctx)
		for _, r := range results {
			fmt.Fprintf(out, "applied %s in %v\n", r.Source.Path, r.Duration)
		}
		if err != nil {
			return fmt.Errorf("migrate up: %w", err)
		}
		if len(results) == 0 {
			fmt.Fprintln(out, "nothing to apply")
		}
	case "down":
		r, err := p.Down(ctx)
		if err != nil {
			return fmt.Errorf("migrate down: %w", err)
		}
		fmt.Fprintf(out, "undid %s\n", r.Source.Path)
	case "status":
		statuses, err := p.Status(ctx)
		if err != nil {
			return fmt.Errorf("migrate status: %w", err)
		}
		for _, s := range statuses {
			fmt.Fprintf(out, "%-8s %s\n", s.State, s.Source.Path)
		}
	default:
		return fmt.Errorf("migrate: unknown command %q: use up, down or status", command)
	}
	return nil
}
