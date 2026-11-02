-- The upstream library (plan 07): saved API endpoints and how they're
-- handled. Every save is a new version, which never changes, and a step
-- that uses an upstream pins one.

-- +goose Up
CREATE TABLE upstreams (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  name           text NOT NULL UNIQUE,
  latest_version int  NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE upstream_versions (
  upstream_id uuid  NOT NULL REFERENCES upstreams ON DELETE CASCADE,
  version     int   NOT NULL,
  definition  jsonb NOT NULL,
  provenance  jsonb NOT NULL,  -- who saved it, and with what
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (upstream_id, version)
);

-- +goose Down
DROP TABLE upstream_versions;
DROP TABLE upstreams;
