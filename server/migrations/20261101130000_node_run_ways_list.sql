-- A merge node runs if any edge into it was taken, so a run records every
-- one that was, as a list: way, the one edge an either node ran with,
-- becomes ways.

-- +goose Up
ALTER TABLE node_runs RENAME COLUMN way TO ways;
UPDATE node_runs SET ways = jsonb_build_array(ways) WHERE jsonb_typeof(ways) = 'object';

-- +goose Down
UPDATE node_runs SET ways = ways -> 0 WHERE jsonb_typeof(ways) = 'array';
ALTER TABLE node_runs RENAME COLUMN ways TO way;
