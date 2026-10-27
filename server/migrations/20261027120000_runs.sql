-- Runs and what each node did. A node's row is written when it ends, so a
-- run that's still going shows its progress, and one cut off by a crash
-- keeps what it had done.

-- +goose Up
CREATE TABLE runs (
  id               uuid  PRIMARY KEY DEFAULT uuidv7(),
  workflow_id      uuid  NOT NULL,
  revision         int   NOT NULL,
  trigger          text  NOT NULL CHECK (trigger IN ('editor', 'served')),
  status           text  NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  input            jsonb NOT NULL,
  output           jsonb,           -- capped like node bodies
  output_truncated bool  NOT NULL DEFAULT false,
  error            jsonb,           -- {code, detail, node}
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  FOREIGN KEY (workflow_id, revision) REFERENCES workflow_revisions
);

CREATE INDEX runs_by_workflow ON runs (workflow_id, id DESC);

CREATE TABLE node_runs (
  run_id     uuid NOT NULL REFERENCES runs ON DELETE CASCADE,
  node_id    text NOT NULL,
  status     text NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped', 'cancelled')),
  attempts   int  NOT NULL,
  request    jsonb,           -- what was sent: secrets redacted, body capped
  response   jsonb,           -- what came back, or a transform's value: the same
  error      jsonb,           -- {code, detail}
  started_at timestamptz,     -- null if it never started
  ended_at   timestamptz NOT NULL,
  PRIMARY KEY (run_id, node_id)
);

-- +goose Down
DROP TABLE node_runs;
DROP TABLE runs;
