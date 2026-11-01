-- A run records the lines each node's answer took, [{to, on, unhandled}],
-- which say the ways into a transform too, so ways goes, and what older
-- runs recorded in it.

-- +goose Up
ALTER TABLE node_runs DROP COLUMN ways;
ALTER TABLE node_runs ADD COLUMN took jsonb;

-- +goose Down
ALTER TABLE node_runs DROP COLUMN took;
ALTER TABLE node_runs ADD COLUMN ways jsonb;
