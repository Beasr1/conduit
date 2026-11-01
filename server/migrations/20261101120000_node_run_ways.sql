-- The way an either node ran with: the edge into it that was taken, as the
-- definition writes it, {from, on, unhandled}. Other nodes have none.

-- +goose Up
ALTER TABLE node_runs ADD COLUMN way jsonb;

-- +goose Down
ALTER TABLE node_runs DROP COLUMN way;
