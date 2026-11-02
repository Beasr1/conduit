-- The W3C trace each run belongs to (plan 06): its caller's, when the call
-- that started it carried one, else one the run started. Runs that call
-- each other through /serve share it. Runs from before this have none.

-- +goose Up
ALTER TABLE runs ADD COLUMN trace_id text CHECK (trace_id ~ '^[0-9a-f]{32}$');

-- +goose Down
ALTER TABLE runs DROP COLUMN trace_id;
