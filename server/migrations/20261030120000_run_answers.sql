-- The status each run answered with. A workflow's response picks it, where
-- an output always answered 200, as every run that succeeded before this did.

-- +goose Up
ALTER TABLE runs ADD COLUMN answered int CHECK (answered BETWEEN 200 AND 599);
UPDATE runs SET answered = 200 WHERE status = 'succeeded';

-- +goose Down
ALTER TABLE runs DROP COLUMN answered;
