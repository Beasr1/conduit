-- Constants (plan 06): named values every expression reads as
-- $const.name. Each value, and the one before its last change, is sealed
-- with AES-256-GCM under the server's key, never stored in the clear.

-- +goose Up
CREATE TABLE constants (
  name       text PRIMARY KEY,
  secret     boolean NOT NULL,
  value      bytea NOT NULL,  -- nonce, ciphertext and tag, the name as associated data
  previous   bytea,           -- the value before the last change, sealed the same way
  provenance jsonb NOT NULL,  -- who set it last, and with what
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE constants;
