package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/runner"
	"github.com/Beasr1/conduit/server/internal/store"
)

func (a *api) StartRun(ctx context.Context, req gen.StartRunRequestObject) (gen.StartRunResponseObject, error) {
	run, err := a.runner.Start(ctx, req.ID, req.Body.Revision, req.Body.Input)
	var invalid *runner.InvalidError
	if errors.As(err, &invalid) {
		return nil, invalidDefinition(problemErrors(invalid.Problems), "Revision %d has problems, so it can't run.", invalid.Revision)
	}
	if err != nil {
		return nil, refusal(err)
	}
	out, err := runOut(run)
	if err != nil {
		return nil, err
	}
	return gen.StartRun202JSONResponse{Body: out, Headers: gen.StartRun202ResponseHeaders{Location: "/v1/runs/" + run.ID}}, nil
}

func (a *api) ListRuns(ctx context.Context, req gen.ListRunsRequestObject) (gen.ListRunsResponseObject, error) {
	limit, err := pageLimit(req.Params.Limit)
	if err != nil {
		return nil, err
	}
	rs, err := a.store.Runs(ctx, req.Params.WorkflowID, limit, req.Params.Before)
	if err != nil {
		return nil, err
	}
	out := gen.ListRuns200JSONResponse{Runs: make([]gen.RunSummary, 0, len(rs))}
	for _, r := range rs {
		s, err := runSummaryOut(r)
		if err != nil {
			return nil, err
		}
		out.Runs = append(out.Runs, s)
	}
	if len(rs) == limit {
		out.Next = rs[len(rs)-1].ID
	}
	return out, nil
}

func (a *api) GetRun(ctx context.Context, req gen.GetRunRequestObject) (gen.GetRunResponseObject, error) {
	r, err := a.store.Run(ctx, req.ID)
	if err != nil {
		return nil, err
	}
	nodes, err := a.store.NodeRuns(ctx, r.ID)
	if err != nil {
		return nil, err
	}
	out, err := runOut(r)
	if err != nil {
		return nil, err
	}
	out.Nodes = make([]gen.NodeRun, 0, len(nodes))
	for _, n := range nodes {
		nr, err := nodeRunOut(n)
		if err != nil {
			return nil, err
		}
		out.Nodes = append(out.Nodes, nr)
	}
	return gen.GetRun200JSONResponse(out), nil
}

func (a *api) StreamRunEvents(ctx context.Context, req gen.StreamRunEventsRequestObject) (gen.StreamRunEventsResponseObject, error) {
	after := 0
	switch id := req.Params.LastEventID; id {
	case "end":
		// The client has the run's own event, so there's nothing more. 204
		// is how a stream says so: an EventSource stops reconnecting.
		if _, err := a.store.Run(ctx, req.ID); err != nil {
			return nil, err
		}
		return gen.StreamRunEvents204Response{}, nil
	case "":
	default:
		n, err := strconv.Atoi(id)
		if err != nil || n < 0 {
			return nil, &problem{
				status: http.StatusBadRequest, code: "invalid_request",
				detail: "Last-Event-ID must be the id of an event from this stream: a whole number, or end.",
			}
		}
		after = n
	}
	w, err := a.runner.Watch(ctx, req.ID, after)
	if errors.Is(err, runner.ErrNotHere) {
		return nil, &problem{
			status: http.StatusServiceUnavailable, code: "not_ready", retryAfter: 1,
			detail: "The run is only just starting. Try again in a moment.",
		}
	}
	if err != nil {
		return nil, err
	}
	select {
	case a.streams <- struct{}{}:
	default:
		return nil, &problem{
			status: http.StatusServiceUnavailable, code: "busy", retryAfter: 5,
			detail: "Too many event streams are open. Try again shortly.",
		}
	}
	return eventStream{ctx: ctx, events: w, log: a.log, release: func() { <-a.streams }}, nil
}

func (a *api) ServeWorkflow(ctx context.Context, req gen.ServeWorkflowRequestObject) (gen.ServeWorkflowResponseObject, error) {
	var input json.RawMessage
	if req.Body != nil {
		input = *req.Body
	}
	out, err := a.runner.Serve(ctx, req.Slug, input)
	var invalid *runner.InvalidError
	switch {
	case errors.Is(err, store.ErrNotFound), errors.Is(err, runner.ErrNotPublished):
		return nil, &problem{status: http.StatusNotFound, code: "not_found", detail: fmt.Sprintf("Nothing is published at /serve/%s.", req.Slug)}
	case errors.As(err, &invalid):
		// Publishing checked this revision, so the checks have changed since.
		return nil, &problem{
			status: http.StatusInternalServerError, code: runner.CodeWorkflow, errors: problemErrors(invalid.Problems),
			detail: fmt.Sprintf("The published revision, %d, has problems. Fix them and publish again.", invalid.Revision),
		}
	case err != nil:
		return nil, refusal(err)
	}
	if f := out.Failure; f != nil {
		return nil, &problem{
			status: servedStatus[f.Code], code: f.Code, detail: f.Detail,
			node: f.Node, instance: "/v1/runs/" + out.Run.ID,
		}
	}
	return servedOutput(out.Output), nil
}

// servedStatus answers a served run that failed, by its failure's code.
var servedStatus = map[string]int{
	runner.CodeUpstream: http.StatusBadGateway,
	runner.CodeTimeout:  http.StatusGatewayTimeout,
	runner.CodeWorkflow: http.StatusInternalServerError,
	runner.CodeInternal: http.StatusInternalServerError,
	// The caller hung up, so no one reads this; it's for the access log.
	runner.CodeCancelled: http.StatusServiceUnavailable,
}

// refusal answers the runner refusing to start a run: the input, or the
// cap. Anything else goes on to answerError.
func refusal(err error) error {
	var input *runner.InputError
	switch {
	case errors.As(err, &input):
		return &problem{
			status: http.StatusBadRequest, code: "invalid_input", errors: problemErrors(input.Problems),
			detail: "The input doesn't match the workflow's input_schema.",
		}
	case errors.Is(err, runner.ErrBusy):
		return &problem{
			status: http.StatusServiceUnavailable, code: "busy", retryAfter: 5,
			detail: "Too many runs are in progress, or the server is shutting down. Try again shortly.",
		}
	}
	return err
}

// servedOutput answers with a run's output as it is. The generated response
// type is a json.RawMessage under another name, which encoding/json would
// send as base64.
type servedOutput json.RawMessage

func (o servedOutput) VisitServeWorkflowResponse(w http.ResponseWriter) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	// The status is out, so a failed write can't change the answer.
	_, _ = w.Write(o)
	return nil
}

func runSummaryOut(r store.Run) (gen.RunSummary, error) {
	out := gen.RunSummary{
		ID: r.ID, WorkflowID: r.WorkflowID, Revision: r.Revision,
		Trigger: gen.RunSummaryTrigger(r.Trigger), Status: gen.RunSummaryStatus(r.Status),
		StartedAt: r.StartedAt.UTC(),
	}
	if r.EndedAt != nil {
		out.EndedAt = r.EndedAt.UTC()
	}
	return out, decodeDoc(r.Error, &out.Error, "run "+r.ID+"'s error")
}

func runOut(r store.Run) (gen.Run, error) {
	s, err := runSummaryOut(r)
	return gen.Run{
		ID: s.ID, WorkflowID: s.WorkflowID, Revision: s.Revision,
		Trigger: gen.RunTrigger(s.Trigger), Status: gen.RunStatus(s.Status),
		Error: s.Error, StartedAt: s.StartedAt, EndedAt: s.EndedAt,
		Input: r.Input, Output: r.Output, OutputTruncated: r.OutputTruncated,
	}, err
}

func nodeRunOut(n store.NodeRun) (gen.NodeRun, error) {
	out := gen.NodeRun{Node: n.NodeID, Status: gen.NodeRunStatus(n.Status), Attempts: n.Attempts, EndedAt: n.EndedAt.UTC()}
	if n.StartedAt != nil {
		out.StartedAt = n.StartedAt.UTC()
	}
	what := "node " + n.NodeID + " of run " + n.RunID
	return out, errors.Join(
		decodeDoc(n.Request, &out.Request, what+"'s request"),
		decodeDoc(n.Response, &out.Response, what+"'s response"),
		decodeDoc(n.Error, &out.Error, what+"'s error"),
	)
}

// decodeDoc decodes a stored JSON document, leaving v as it is when there's
// none.
func decodeDoc(doc json.RawMessage, v any, what string) error {
	if doc == nil {
		return nil
	}
	if err := json.Unmarshal(doc, v); err != nil {
		return fmt.Errorf("decode %s: %w", what, err)
	}
	return nil
}
