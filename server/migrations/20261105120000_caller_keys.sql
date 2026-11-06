-- Caller keys (plan 07): a workflow is served with keys of its own, one
-- per caller, each named. A key is shown once, when it's made; a row keeps
-- its SHA-256 and its first characters, so the table alone serves nothing.
-- Rotating a key gives it an expiry and revoking stops it; neither deletes
-- it. A served run records the key it was called with.

-- +goose Up
CREATE TABLE caller_keys (
  id          uuid  PRIMARY KEY DEFAULT uuidv7(),
  workflow_id uuid  NOT NULL REFERENCES workflows,
  name        text  NOT NULL,         -- who calls with it
  prefix      text  NOT NULL,         -- its first characters, to tell it apart
  hash        bytea NOT NULL UNIQUE,  -- SHA-256 of the key
  expires_at  timestamptz,            -- set when it's rotated: it works until then
  revoked_at  timestamptz,            -- set when it's revoked: it works no more
  provenance  jsonb NOT NULL,         -- who made it, and with what
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workflow_id)            -- what a run's key and workflow refer to together
);

-- A workflow's keys not yet rotated or revoked each have a name of their own.
CREATE UNIQUE INDEX caller_keys_active_name ON caller_keys (workflow_id, name)
  WHERE expires_at IS NULL AND revoked_at IS NULL;

-- A run's key is one of its own workflow's, and only a served run has one.
ALTER TABLE runs ADD COLUMN caller_key uuid;
ALTER TABLE runs ADD CONSTRAINT runs_caller_key
  FOREIGN KEY (caller_key, workflow_id) REFERENCES caller_keys (id, workflow_id);
ALTER TABLE runs ADD CONSTRAINT runs_caller_key_served CHECK (caller_key IS NULL OR trigger = 'served');
-- A key's last use is its latest run.
CREATE INDEX runs_by_caller_key ON runs (caller_key, started_at) WHERE caller_key IS NOT NULL;

-- +goose Down
DROP INDEX runs_by_caller_key;
ALTER TABLE runs DROP CONSTRAINT runs_caller_key_served;
ALTER TABLE runs DROP CONSTRAINT runs_caller_key;
ALTER TABLE runs DROP COLUMN caller_key;
DROP TABLE caller_keys;
