-- A run of a workflow a step uses (plan 07): its trigger is workflow, and
-- it names the run, and the node in it, it was called from.

-- +goose Up
ALTER TABLE runs DROP CONSTRAINT runs_trigger_check;
ALTER TABLE runs ADD CONSTRAINT runs_trigger_check CHECK (trigger IN ('editor', 'served', 'workflow'));
ALTER TABLE runs ADD COLUMN parent_run uuid REFERENCES runs;
ALTER TABLE runs ADD COLUMN parent_node text;
ALTER TABLE runs ADD CONSTRAINT runs_parent CHECK (
  (trigger = 'workflow') = (parent_run IS NOT NULL) AND (parent_run IS NULL) = (parent_node IS NULL)
);
CREATE INDEX runs_by_parent ON runs (parent_run) WHERE parent_run IS NOT NULL;

-- +goose Down
DROP INDEX runs_by_parent;
ALTER TABLE runs DROP CONSTRAINT runs_parent;
DELETE FROM runs WHERE trigger = 'workflow';
ALTER TABLE runs DROP COLUMN parent_node;
ALTER TABLE runs DROP COLUMN parent_run;
ALTER TABLE runs DROP CONSTRAINT runs_trigger_check;
ALTER TABLE runs ADD CONSTRAINT runs_trigger_check CHECK (trigger IN ('editor', 'served'));
