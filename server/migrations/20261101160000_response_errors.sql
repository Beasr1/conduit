-- The response's Unhandled body is its error body now, as it answers every
-- error the workflow passes on without a body of its own (plan 12), so a
-- definition's response.unhandled is response.errors. The field is renamed
-- in place, so older revisions still decode; what the body means grew with
-- it, as the answers it gives do.

-- +goose Up
UPDATE workflow_revisions
SET definition = jsonb_set(definition #- '{response,unhandled}', '{response,errors}', definition #> '{response,unhandled}')
WHERE definition #> '{response,unhandled}' IS NOT NULL;

-- +goose Down
UPDATE workflow_revisions
SET definition = jsonb_set(definition #- '{response,errors}', '{response,unhandled}', definition #> '{response,errors}')
WHERE definition #> '{response,errors}' IS NOT NULL;
