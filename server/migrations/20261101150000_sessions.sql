-- The web app's sessions (plan 04, Signing in). The cookie holds a random
-- id; a row keeps its SHA-256, so the table alone signs no one in. Signing
-- out deletes the row. A session is refused once it goes unused for its idle
-- time or reaches its expiry, and a later sign-in clears it away.

-- +goose Up
CREATE TABLE sessions (
    id_hash    bytea PRIMARY KEY,
    seen_at    timestamptz NOT NULL,
    expires_at timestamptz NOT NULL
);

-- +goose Down
DROP TABLE sessions;
