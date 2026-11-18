package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/store"
)

// A changes list on each workflow (plan 16): what happens to what it uses,
// active until it's dealt with or dismissed, and kept for good.

func (a *api) ListChanges(ctx context.Context, req gen.ListChangesRequestObject) (gen.ListChangesResponseObject, error) {
	limit, err := pageLimit(req.Params.Limit)
	if err != nil {
		return nil, err
	}
	cs, err := a.store.WorkflowChanges(ctx, req.ID, req.Params.History, limit, req.Params.Before)
	if err != nil {
		return nil, err
	}
	out := gen.ListChanges200JSONResponse{Changes: make([]gen.Change, 0, len(cs))}
	for _, c := range cs {
		out.Changes = append(out.Changes, changeOut(c))
	}
	if len(cs) == limit {
		out.Next = cs[len(cs)-1].ID
	}
	return out, nil
}

func (a *api) DismissChange(ctx context.Context, req gen.DismissChangeRequestObject) (gen.DismissChangeResponseObject, error) {
	c, err := a.store.DismissChange(ctx, req.ID, req.Change, provenance(ctx))
	if errors.Is(err, store.ErrNotFound) {
		return nil, &problem{status: http.StatusNotFound, code: "not_found", detail: "The workflow's list has no such change."}
	}
	if err != nil {
		return nil, err
	}
	return gen.DismissChange200JSONResponse(changeOut(c)), nil
}

func (a *api) ListUpstreamChanges(ctx context.Context, req gen.ListUpstreamChangesRequestObject) (gen.ListUpstreamChangesResponseObject, error) {
	if _, err := a.store.Upstream(ctx, req.ID); err != nil {
		return nil, noUpstream(err)
	}
	out, err := a.recordsOf(ctx, "upstream", req.ID, req.Params.Limit, req.Params.Before)
	if err != nil {
		return nil, err
	}
	return gen.ListUpstreamChanges200JSONResponse(out), nil
}

func (a *api) ListConstantChanges(ctx context.Context, req gen.ListConstantChangesRequestObject) (gen.ListConstantChangesResponseObject, error) {
	if _, err := a.store.Constant(ctx, req.Name); err != nil {
		return nil, noConstant(err)
	}
	out, err := a.recordsOf(ctx, "constant", req.Name, req.Params.Limit, req.Params.Before)
	if err != nil {
		return nil, err
	}
	return gen.ListConstantChanges200JSONResponse(out), nil
}

// recordsOf is a page of what happened to one thing, as recorded.
func (a *api) recordsOf(ctx context.Context, subject, id string, limit int, before string) (gen.ChangeRecordList, error) {
	limit, err := pageLimit(limit)
	if err != nil {
		return gen.ChangeRecordList{}, err
	}
	rs, err := a.store.SubjectChanges(ctx, subject, id, limit, before)
	if err != nil {
		return gen.ChangeRecordList{}, err
	}
	out := gen.ChangeRecordList{Changes: make([]gen.ChangeRecord, 0, len(rs))}
	for _, r := range rs {
		out.Changes = append(out.Changes, gen.ChangeRecord{
			ID: r.ID, Kind: gen.ChangeRecordKind(r.Kind), Subject: gen.ChangeRecordSubject(r.Subject), SubjectID: r.SubjectID,
			Detail: detailOut(r.Detail), Provenance: provenanceOut(r.Provenance), CreatedAt: r.CreatedAt.UTC(),
		})
	}
	if len(rs) == limit {
		out.Next = rs[len(rs)-1].ID
	}
	return out, nil
}

func changeOut(c store.Change) gen.Change {
	out := gen.Change{
		ID: c.ID, Kind: gen.ChangeKind(c.Kind), Subject: gen.ChangeSubject(c.Subject), SubjectID: c.SubjectID,
		Detail: detailOut(c.Detail), Provenance: provenanceOut(c.Provenance), CreatedAt: c.CreatedAt.UTC(),
		State: gen.ChangeState(c.State),
	}
	out.DismissedAt, out.DismissedBy = archiveOut(c.DismissedAt, c.DismissedBy)
	return out
}

func detailOut(d store.ChangeDetail) gen.ChangeDetail {
	out := gen.ChangeDetail{
		Name: d.Name, Version: d.Version, Revision: d.Revision, How: gen.ChangeDetailHow(d.How),
		Prefix: d.Prefix, Keys: int(d.Keys),
	}
	if d.ExpiresAt != nil {
		out.ExpiresAt = d.ExpiresAt.UTC()
	}
	return out
}
