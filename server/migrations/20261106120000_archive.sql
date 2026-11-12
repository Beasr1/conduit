-- Archive, never delete (plan 15): a workflow, an upstream or a constant
-- nothing live uses is taken out of use and kept, read-only, until it's
-- restored. Each row says when, and by what.

-- +goose Up
ALTER TABLE workflows
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by jsonb,
  ADD CONSTRAINT workflows_archived CHECK ((archived_at IS NULL) = (archived_by IS NULL));
ALTER TABLE upstreams
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by jsonb,
  ADD CONSTRAINT upstreams_archived CHECK ((archived_at IS NULL) = (archived_by IS NULL));
ALTER TABLE constants
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by jsonb,
  ADD CONSTRAINT constants_archived CHECK ((archived_at IS NULL) = (archived_by IS NULL));

-- +goose Down
ALTER TABLE constants DROP COLUMN archived_at, DROP COLUMN archived_by;
ALTER TABLE upstreams DROP COLUMN archived_at, DROP COLUMN archived_by;
ALTER TABLE workflows DROP COLUMN archived_at, DROP COLUMN archived_by;
