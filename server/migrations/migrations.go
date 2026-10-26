// Package migrations holds the database schema as goose SQL files, embedded
// so `conduit migrate up` needs nothing beside the binary. An applied
// migration is never edited; a change is a new file.
package migrations

import "embed"

// FS holds every migration, named by the UTC time it was written.
//
//go:embed *.sql
var FS embed.FS
