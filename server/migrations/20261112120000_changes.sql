-- A changes list on each workflow (plan 16): what happens to what it uses,
-- recorded as it happens, in the transaction that makes it, and never
-- deleted. A change is recorded once; each workflow it touches, worked out
-- then, has an entry for it. Whether an entry is still active is worked out
-- as it's read, from the change and how things stand, so only a dismissal
-- is ever written to it.

-- +goose Up
CREATE TABLE changes (
  id         uuid  PRIMARY KEY DEFAULT uuidv7(),
  kind       text  NOT NULL,  -- what happened: constant_changed, upstream_version, …
  subject    text  NOT NULL,  -- what it happened to: workflow, upstream, constant or key
  subject_id text  NOT NULL,  -- its id, or a constant's name
  detail     jsonb NOT NULL,  -- what a line about it says: names, numbers, an expiry; never a value
  provenance jsonb NOT NULL,  -- who did it, and with what
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX changes_by_subject ON changes (subject, subject_id, id);

CREATE TABLE workflow_changes (
  workflow_id  uuid NOT NULL REFERENCES workflows,
  change_id    uuid NOT NULL REFERENCES changes,
  dismissed_at timestamptz,
  dismissed_by jsonb,
  PRIMARY KEY (workflow_id, change_id),
  CONSTRAINT workflow_changes_dismissed CHECK ((dismissed_at IS NULL) = (dismissed_by IS NULL))
);

-- +goose Down
DROP TABLE workflow_changes;
DROP TABLE changes;
