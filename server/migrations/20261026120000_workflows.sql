-- Workflows and their revisions. Every save is a new revision, and a
-- revision never changes, so a run can always say exactly what it ran.

-- +goose Up
CREATE TABLE workflows (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  slug               text NOT NULL UNIQUE,  -- served at /serve/{slug}
  name               text NOT NULL,
  latest_revision    int  NOT NULL,
  published_revision int,                   -- null until published
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workflow_revisions (
  workflow_id uuid  NOT NULL REFERENCES workflows ON DELETE CASCADE,
  revision    int   NOT NULL,
  definition  jsonb NOT NULL,
  provenance  jsonb NOT NULL,  -- who saved it, and with what
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_id, revision)
);

-- +goose Down
DROP TABLE workflow_revisions;
DROP TABLE workflows;
