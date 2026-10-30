package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Beasr1/conduit/server/internal/engine"
	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// slugPattern keeps a slug safe as one URL path segment: /serve/{slug}.
var slugPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`)

func (a *api) CreateWorkflow(ctx context.Context, req gen.CreateWorkflowRequestObject) (gen.CreateWorkflowResponseObject, error) {
	b := req.Body
	var ps []gen.ProblemError
	if !slugPattern.MatchString(b.Slug) {
		ps = append(ps, gen.ProblemError{
			Pointer: "/slug", Code: "invalid_slug",
			Detail: "a slug is 1 to 64 lowercase letters, digits and hyphens, not starting or ending with a hyphen",
		})
	}
	if n := utf8.RuneCountInString(b.Name); n < 1 || n > 200 {
		ps = append(ps, gen.ProblemError{Pointer: "/name", Code: "invalid_name", Detail: "a name is 1 to 200 characters"})
	}
	if len(ps) > 0 {
		return nil, &problem{
			status: http.StatusUnprocessableEntity, code: "invalid_request",
			detail: "The request has problems; nothing was saved.", errors: ps,
		}
	}
	def, err := json.Marshal(b.Definition)
	if err != nil {
		return nil, fmt.Errorf("encode definition: %w", err)
	}
	w, r, err := a.store.CreateWorkflow(ctx, b.Slug, b.Name, def, provenance(ctx))
	if err != nil {
		return nil, err
	}
	rev, err := revisionOut(r)
	if err != nil {
		return nil, err
	}
	return gen.CreateWorkflow201JSONResponse{
		Body:    gen.WorkflowRevision{Workflow: workflowOut(w), Revision: rev},
		Headers: gen.CreateWorkflow201ResponseHeaders{ETag: etag(r.Revision), Location: "/v1/workflows/" + w.ID},
	}, nil
}

func (a *api) ListWorkflows(ctx context.Context, req gen.ListWorkflowsRequestObject) (gen.ListWorkflowsResponseObject, error) {
	limit, err := pageLimit(req.Params.Limit)
	if err != nil {
		return nil, err
	}
	ws, err := a.store.Workflows(ctx, limit, req.Params.Before)
	if err != nil {
		return nil, err
	}
	out := gen.ListWorkflows200JSONResponse{Workflows: make([]gen.Workflow, 0, len(ws))}
	for _, w := range ws {
		out.Workflows = append(out.Workflows, workflowOut(w))
	}
	if len(ws) == limit {
		out.Next = ws[len(ws)-1].ID
	}
	return out, nil
}

func (a *api) GetWorkflow(ctx context.Context, req gen.GetWorkflowRequestObject) (gen.GetWorkflowResponseObject, error) {
	w, err := a.store.Workflow(ctx, req.ID)
	if err != nil {
		return nil, err
	}
	r, err := a.store.Revision(ctx, w.ID, w.LatestRevision)
	if err != nil {
		return nil, err
	}
	rev, err := revisionOut(r)
	if err != nil {
		return nil, err
	}
	return gen.GetWorkflow200JSONResponse{
		Body:    gen.WorkflowRevision{Workflow: workflowOut(w), Revision: rev},
		Headers: gen.GetWorkflow200ResponseHeaders{ETag: etag(r.Revision)},
	}, nil
}

func (a *api) SaveDraft(ctx context.Context, req gen.SaveDraftRequestObject) (gen.SaveDraftResponseObject, error) {
	if req.Params.IfMatch == "" {
		return nil, &problem{
			status: http.StatusPreconditionRequired, code: "if_match_required",
			detail: "Send the latest revision's ETag as If-Match, so this save can't undo someone else's.",
		}
	}
	base, ok := parseETag(req.Params.IfMatch)
	if !ok {
		return nil, &problem{
			status: http.StatusPreconditionFailed, code: "revision_mismatch",
			detail: `If-Match must be one revision's ETag, such as "3".`,
		}
	}
	def, err := json.Marshal(req.Body)
	if err != nil {
		return nil, fmt.Errorf("encode definition: %w", err)
	}
	r, err := a.store.SaveRevision(ctx, req.ID, base, def, provenance(ctx))
	if err != nil {
		return nil, err
	}
	rev, err := revisionOut(r)
	if err != nil {
		return nil, err
	}
	return gen.SaveDraft200JSONResponse{Body: rev, Headers: gen.SaveDraft200ResponseHeaders{ETag: etag(r.Revision)}}, nil
}

func (a *api) ListRevisions(ctx context.Context, req gen.ListRevisionsRequestObject) (gen.ListRevisionsResponseObject, error) {
	rs, err := a.store.Revisions(ctx, req.ID)
	if err != nil {
		return nil, err
	}
	out := gen.ListRevisions200JSONResponse{Revisions: make([]gen.RevisionSummary, 0, len(rs))}
	for _, r := range rs {
		out.Revisions = append(out.Revisions, gen.RevisionSummary{Revision: r.Revision, Provenance: provenanceOut(r.Provenance), CreatedAt: r.CreatedAt.UTC()})
	}
	return out, nil
}

func (a *api) GetRevision(ctx context.Context, req gen.GetRevisionRequestObject) (gen.GetRevisionResponseObject, error) {
	r, err := a.store.Revision(ctx, req.ID, req.Revision)
	if err != nil {
		return nil, err
	}
	rev, err := revisionOut(r)
	if err != nil {
		return nil, err
	}
	return gen.GetRevision200JSONResponse(rev), nil
}

func (a *api) PublishWorkflow(ctx context.Context, req gen.PublishWorkflowRequestObject) (gen.PublishWorkflowResponseObject, error) {
	r, err := a.store.Revision(ctx, req.ID, req.Body.Revision)
	if err != nil {
		return nil, err
	}
	rev, err := revisionOut(r)
	if err != nil {
		return nil, err
	}
	if len(rev.Problems) > 0 {
		return nil, invalidDefinition(rev.Problems, "Revision %d has problems, so it can't be published.", r.Revision)
	}
	w, err := a.store.Publish(ctx, req.ID, r.Revision)
	if err != nil {
		return nil, err
	}
	return gen.PublishWorkflow200JSONResponse(workflowOut(w)), nil
}

func (*api) ValidateDefinition(_ context.Context, req gen.ValidateDefinitionRequestObject) (gen.ValidateDefinitionResponseObject, error) {
	return gen.ValidateDefinition200JSONResponse{Problems: problemsOf(req.Body)}, nil
}

// previewTimeout bounds a whole preview. Each expression on the way has
// its own guardrails, and a definition can hold a lot of them.
const previewTimeout = 3 * time.Second

func (*api) PreviewDefinition(ctx context.Context, req gen.PreviewDefinitionRequestObject) (gen.PreviewDefinitionResponseObject, error) {
	ctx, cancel := context.WithTimeout(ctx, previewTimeout)
	defer cancel()
	b := req.Body
	var pv *engine.Preview
	var err error
	switch {
	case b.Edge != nil && b.Node != "":
		return nil, &problem{
			status: http.StatusUnprocessableEntity, code: "invalid_request", detail: "Preview a step or a connection, not both.",
			errors: []gen.ProblemError{{Pointer: "/edge", Code: "not_allowed", Detail: "a preview is of a node or an edge, not both"}},
		}
	case b.Edge != nil:
		pv, err = engine.SimulateEdge(ctx, &b.Definition, *b.Edge)
	default:
		pv, err = engine.Simulate(ctx, &b.Definition, b.Node)
	}
	switch {
	case errors.Is(err, engine.ErrNoSuchNode):
		return nil, &problem{
			status: http.StatusUnprocessableEntity, code: "invalid_request", detail: "There's no such step to preview.",
			errors: []gen.ProblemError{{Pointer: "/node", Code: "unknown_node", Detail: fmt.Sprintf("no node has the id %q", b.Node)}},
		}
	case errors.Is(err, engine.ErrNoSuchEdge):
		return nil, &problem{
			status: http.StatusUnprocessableEntity, code: "invalid_request", detail: "There's no such connection to preview.",
			errors: []gen.ProblemError{{Pointer: "/edge", Code: "unknown_edge", Detail: fmt.Sprintf("the definition has no edge at %d", *b.Edge)}},
		}
	case err != nil:
		return nil, err
	}
	out := gen.PreviewDefinition200JSONResponse{Reads: pv.Reads, Gives: pv.Gives, Taken: pv.Taken, Skipped: pv.Skipped, Problems: problemErrors(pv.Problems)}
	if s := pv.Sends; s != nil {
		headers := make(map[string]string, len(s.Header))
		for name, values := range s.Header {
			headers[name] = strings.Join(values, ", ")
		}
		out.Sends = gen.RenderedRequest{Method: s.Method, URL: s.URL, Headers: headers, Body: s.Body}
	}
	return out, nil
}

func invalidDefinition(ps []gen.ProblemError, format string, args ...any) *problem {
	return &problem{status: http.StatusUnprocessableEntity, code: "invalid_definition", detail: fmt.Sprintf(format, args...), errors: ps}
}

// pageLimit is a list's limit parameter, or the default page size.
func pageLimit(limit int) (int, error) {
	switch {
	case limit == 0:
		return 50, nil
	case limit < 1 || limit > 200:
		return 0, &problem{status: http.StatusBadRequest, code: "invalid_request", detail: "limit is 1 to 200"}
	}
	return limit, nil
}

// problemsOf is everything engine.Compile finds wrong with d.
func problemsOf(d *workflow.Definition) []gen.ProblemError {
	_, err := engine.Compile(d)
	var ps workflow.Problems
	if !errors.As(err, &ps) {
		return problemErrors(nil)
	}
	return problemErrors(ps)
}

// problemErrors is ps as the API sends them: [] rather than null when there
// are none, since the field is required where it appears.
func problemErrors(ps []workflow.Problem) []gen.ProblemError {
	out := make([]gen.ProblemError, 0, len(ps))
	for _, p := range ps {
		out = append(out, gen.ProblemError{Pointer: p.Pointer, Code: p.Code, Detail: p.Detail})
	}
	return out
}

func provenance(ctx context.Context) store.Provenance {
	c := callerFrom(ctx)
	return store.Provenance{Actor: c.actor, Client: c.client}
}

func provenanceOut(p store.Provenance) gen.Provenance {
	return gen.Provenance{Actor: p.Actor, Client: p.Client}
}

// workflowOut and revisionOut send times in UTC, whatever the server's zone:
// pgx hands them back in local time.
func workflowOut(w store.Workflow) gen.Workflow {
	out := gen.Workflow{ID: w.ID, Slug: w.Slug, Name: w.Name, LatestRevision: w.LatestRevision, CreatedAt: w.CreatedAt.UTC()}
	if w.PublishedRevision != nil {
		out.PublishedRevision = *w.PublishedRevision
	}
	return out
}

func revisionOut(r store.Revision) (gen.Revision, error) {
	var d workflow.Definition
	if err := json.Unmarshal(r.Definition, &d); err != nil {
		return gen.Revision{}, fmt.Errorf("decode revision %d of %s: %w", r.Revision, r.WorkflowID, err)
	}
	return gen.Revision{
		WorkflowID: r.WorkflowID,
		Revision:   r.Revision,
		Definition: d,
		Problems:   problemsOf(&d),
		Provenance: provenanceOut(r.Provenance),
		CreatedAt:  r.CreatedAt.UTC(),
	}, nil
}

// etag is a revision as a strong entity tag: "3".
func etag(revision int) string { return strconv.Quote(strconv.Itoa(revision)) }

// parseETag reads a strong entity tag naming a revision. A weak tag (W/"3")
// or * doesn't count: a save must name exactly what it builds on.
func parseETag(s string) (int, bool) {
	u, err := strconv.Unquote(s)
	if err != nil || len(s) < 2 || s[0] != '"' {
		return 0, false
	}
	n, err := strconv.Atoi(u)
	return n, err == nil && n >= 1
}
