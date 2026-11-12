package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/Beasr1/conduit/server/internal/engine"
	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// The upstream library (plan 07): saved API endpoints and how they're
// handled. Every save is a version that never changes, and a step that uses
// an upstream pins one, so a version with problems isn't saved at all.

func (a *api) ListUpstreams(ctx context.Context, req gen.ListUpstreamsRequestObject) (gen.ListUpstreamsResponseObject, error) {
	limit, err := pageLimit(req.Params.Limit)
	if err != nil {
		return nil, err
	}
	us, err := a.store.Upstreams(ctx, limit, req.Params.Before, req.Params.Archived)
	if err != nil {
		return nil, err
	}
	out := gen.ListUpstreams200JSONResponse{Upstreams: make([]gen.UpstreamSummary, 0, len(us))}
	for _, u := range us {
		out.Upstreams = append(out.Upstreams, upstreamOut(u))
	}
	if len(us) == limit {
		out.Next = us[len(us)-1].ID
	}
	return out, nil
}

func (a *api) CreateUpstream(ctx context.Context, req gen.CreateUpstreamRequestObject) (gen.CreateUpstreamResponseObject, error) {
	b := req.Body
	if n := utf8.RuneCountInString(b.Name); n < 1 || n > 200 {
		return nil, &problem{
			status: http.StatusUnprocessableEntity, code: "invalid_request",
			detail: "The request has problems; nothing was saved.",
			errors: []gen.ProblemError{{Pointer: "/name", Code: "invalid_name", Detail: "a name is 1 to 200 characters"}},
		}
	}
	if err := a.checkUpstream(ctx, "/definition", &b.Definition); err != nil {
		return nil, err
	}
	def, err := json.Marshal(b.Definition)
	if err != nil {
		return nil, fmt.Errorf("encode upstream: %w", err)
	}
	u, v, err := a.store.CreateUpstream(ctx, b.Name, def, provenance(ctx))
	if errors.Is(err, store.ErrArchivedName) {
		return nil, &problem{status: http.StatusConflict, code: "conflict", detail: "An archived upstream has that name: restore it, or pick another."}
	}
	if errors.Is(err, store.ErrConflict) {
		return nil, &problem{status: http.StatusConflict, code: "conflict", detail: "An upstream already has that name."}
	}
	if err != nil {
		return nil, err
	}
	out, err := upstreamVersionOut(u, v)
	if err != nil {
		return nil, err
	}
	return gen.CreateUpstream201JSONResponse{
		Body:    out,
		Headers: gen.CreateUpstream201ResponseHeaders{ETag: etag(v.Version), Location: "/v1/upstreams/" + u.ID},
	}, nil
}

func (a *api) GetUpstream(ctx context.Context, req gen.GetUpstreamRequestObject) (gen.GetUpstreamResponseObject, error) {
	u, err := a.store.Upstream(ctx, req.ID)
	if err != nil {
		return nil, noUpstream(err)
	}
	v, err := a.store.UpstreamVersion(ctx, u.ID, u.LatestVersion)
	if err != nil {
		return nil, err
	}
	out, err := upstreamVersionOut(u, v)
	if err != nil {
		return nil, err
	}
	return gen.GetUpstream200JSONResponse{Body: out, Headers: gen.GetUpstream200ResponseHeaders{ETag: etag(v.Version)}}, nil
}

func (a *api) SaveUpstream(ctx context.Context, req gen.SaveUpstreamRequestObject) (gen.SaveUpstreamResponseObject, error) {
	if req.Params.IfMatch == "" {
		return nil, &problem{
			status: http.StatusPreconditionRequired, code: "if_match_required",
			detail: "Send the latest version's ETag as If-Match, so this save can't undo someone else's.",
		}
	}
	base, ok := parseETag(req.Params.IfMatch)
	if !ok {
		return nil, &problem{
			status: http.StatusPreconditionFailed, code: "version_mismatch",
			detail: `If-Match must be one version's ETag, such as "3".`,
		}
	}
	if err := a.checkUpstream(ctx, "", req.Body); err != nil {
		return nil, err
	}
	def, err := json.Marshal(req.Body)
	if err != nil {
		return nil, fmt.Errorf("encode upstream: %w", err)
	}
	v, err := a.store.SaveUpstreamVersion(ctx, req.ID, base, def, provenance(ctx))
	if err != nil {
		return nil, noUpstream(err)
	}
	u, err := a.store.Upstream(ctx, req.ID)
	if err != nil {
		return nil, err
	}
	out, err := upstreamVersionOut(u, v)
	if err != nil {
		return nil, err
	}
	return gen.SaveUpstream200JSONResponse{Body: out, Headers: gen.SaveUpstream200ResponseHeaders{ETag: etag(v.Version)}}, nil
}

func (a *api) GetUpstreamVersion(ctx context.Context, req gen.GetUpstreamVersionRequestObject) (gen.GetUpstreamVersionResponseObject, error) {
	u, err := a.store.Upstream(ctx, req.ID)
	if err != nil {
		return nil, noUpstream(err)
	}
	v, err := a.store.UpstreamVersion(ctx, u.ID, req.Version)
	if errors.Is(err, store.ErrNotFound) {
		return nil, &problem{status: http.StatusNotFound, code: "not_found", detail: fmt.Sprintf("The upstream has no version %d.", req.Version)}
	}
	if err != nil {
		return nil, err
	}
	out, err := upstreamVersionOut(u, v)
	if err != nil {
		return nil, err
	}
	return gen.GetUpstreamVersion200JSONResponse(out), nil
}

func (a *api) ValidateUpstream(ctx context.Context, req gen.ValidateUpstreamRequestObject) (gen.ValidateUpstreamResponseObject, error) {
	known, err := a.store.ConstantNames(ctx)
	if err != nil {
		return nil, err
	}
	return gen.ValidateUpstream200JSONResponse{Problems: problemErrors(engine.CheckUpstream(req.Body, known))}, nil
}

func (a *api) ListUpstreamUsers(ctx context.Context, req gen.ListUpstreamUsersRequestObject) (gen.ListUpstreamUsersResponseObject, error) {
	us, err := a.store.UpstreamUsers(ctx, req.ID)
	if err != nil {
		return nil, noUpstream(err)
	}
	out := gen.ListUpstreamUsers200JSONResponse{Workflows: make([]gen.UpstreamUse, 0, len(us))}
	for _, u := range us {
		out.Workflows = append(out.Workflows, gen.UpstreamUse{
			WorkflowID: u.WorkflowID, Name: u.Name, Revision: u.Revision, Versions: u.Versions, Published: u.Published,
		})
	}
	return out, nil
}

// checkUpstream refuses a version with problems, each pointing into the
// request's body, where the version is at prefix.
func (a *api) checkUpstream(ctx context.Context, prefix string, u *workflow.Upstream) error {
	known, err := a.store.ConstantNames(ctx)
	if err != nil {
		return err
	}
	ps := engine.CheckUpstream(u, known)
	if len(ps) == 0 {
		return nil
	}
	errs := problemErrors(ps)
	for i := range errs {
		errs[i].Pointer = prefix + errs[i].Pointer
	}
	return &problem{
		status: http.StatusUnprocessableEntity, code: "invalid_upstream", errors: errs,
		detail: "The upstream has problems, so nothing was saved: a step that uses a version needs it whole.",
	}
}

// and joins words as a list: "a", "a and b", "a, b and c".
func and(words []string) string {
	if len(words) < 2 {
		return strings.Join(words, "")
	}
	return strings.Join(words[:len(words)-1], ", ") + " and " + words[len(words)-1]
}

// noUpstream says an upstream isn't there in the library's words.
func noUpstream(err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return &problem{status: http.StatusNotFound, code: "not_found", detail: "There's no such upstream."}
	}
	return err
}

func upstreamOut(u store.Upstream) gen.UpstreamSummary {
	out := gen.UpstreamSummary{ID: u.ID, Name: u.Name, LatestVersion: u.LatestVersion, CreatedAt: u.CreatedAt.UTC()}
	out.ArchivedAt, out.ArchivedBy = archiveOut(u.ArchivedAt, u.ArchivedBy)
	return out
}

func upstreamVersionOut(u store.Upstream, v store.UpstreamVersion) (gen.UpstreamVersion, error) {
	out := gen.UpstreamVersion{
		Upstream: upstreamOut(u), Version: v.Version,
		Provenance: provenanceOut(v.Provenance), CreatedAt: v.CreatedAt.UTC(),
	}
	return out, decodeDoc(v.Definition, &out.Definition, fmt.Sprintf("upstream %s version %d", u.ID, v.Version))
}
