-- An answer takes lines from any number of nodes' blocks now, and a run
-- answers with the first answer, top to bottom, that one of its lines
-- reached (plan 14). Each saved answer's one line, its from, on and
-- unhandled, moves into its list of lines, in place and in order, so older
-- revisions still decode and answer as they did. Down keeps each answer's
-- first line.

-- +goose Up
UPDATE workflow_revisions
SET definition = jsonb_set(definition, '{response,answers}', (
    SELECT jsonb_agg(
        CASE
            WHEN a -> 'from' IS NOT NULL THEN
                (a - 'from' - 'on' - 'unhandled') || jsonb_build_object('lines', jsonb_build_array(
                    jsonb_strip_nulls(jsonb_build_object('from', a -> 'from', 'on', a -> 'on', 'unhandled', a -> 'unhandled'))))
            ELSE a - 'on' - 'unhandled'
        END
        ORDER BY i)
    FROM jsonb_array_elements(definition #> '{response,answers}') WITH ORDINALITY AS t(a, i)))
WHERE jsonb_typeof(definition #> '{response,answers}') = 'array'
    AND jsonb_array_length(definition #> '{response,answers}') > 0;

-- +goose Down
UPDATE workflow_revisions
SET definition = jsonb_set(definition, '{response,answers}', (
    SELECT jsonb_agg((a - 'lines') || COALESCE(a #> '{lines,0}', '{}'::jsonb) ORDER BY i)
    FROM jsonb_array_elements(definition #> '{response,answers}') WITH ORDINALITY AS t(a, i)))
WHERE jsonb_typeof(definition #> '{response,answers}') = 'array'
    AND jsonb_array_length(definition #> '{response,answers}') > 0;
