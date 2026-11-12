package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/store"
)

// Archive, never delete (plan 15): what's done with is taken out of use and
// kept, read-only, until it's restored. A key is revoked, and sessions alone
// are deleted, as they're sign-ins and nothing anyone made.

func (a *api) ArchiveWorkflow(ctx context.Context, req gen.ArchiveWorkflowRequestObject) (gen.ArchiveWorkflowResponseObject, error) {
	w, err := a.store.ArchiveWorkflow(ctx, req.ID, provenance(ctx))
	if err != nil {
		return nil, inUse(err)
	}
	return gen.ArchiveWorkflow200JSONResponse(workflowOut(w)), nil
}

func (a *api) RestoreWorkflow(ctx context.Context, req gen.RestoreWorkflowRequestObject) (gen.RestoreWorkflowResponseObject, error) {
	w, err := a.store.RestoreWorkflow(ctx, req.ID)
	if err != nil {
		return nil, err
	}
	return gen.RestoreWorkflow200JSONResponse(workflowOut(w)), nil
}

func (a *api) ArchiveUpstream(ctx context.Context, req gen.ArchiveUpstreamRequestObject) (gen.ArchiveUpstreamResponseObject, error) {
	u, err := a.store.ArchiveUpstream(ctx, req.ID, provenance(ctx))
	if err != nil {
		return nil, noUpstream(inUse(err))
	}
	return gen.ArchiveUpstream200JSONResponse(upstreamOut(u)), nil
}

func (a *api) RestoreUpstream(ctx context.Context, req gen.RestoreUpstreamRequestObject) (gen.RestoreUpstreamResponseObject, error) {
	u, err := a.store.RestoreUpstream(ctx, req.ID)
	if err != nil {
		return nil, noUpstream(err)
	}
	return gen.RestoreUpstream200JSONResponse(upstreamOut(u)), nil
}

func (a *api) ArchiveConstant(ctx context.Context, req gen.ArchiveConstantRequestObject) (gen.ArchiveConstantResponseObject, error) {
	c, err := a.store.ArchiveConstant(ctx, req.Name, provenance(ctx))
	if err != nil {
		return nil, noConstant(inUse(err))
	}
	return gen.ArchiveConstant200JSONResponse(constantOut(c)), nil
}

func (a *api) RestoreConstant(ctx context.Context, req gen.RestoreConstantRequestObject) (gen.RestoreConstantResponseObject, error) {
	c, err := a.store.RestoreConstant(ctx, req.Name)
	if err != nil {
		return nil, noConstant(err)
	}
	return gen.RestoreConstant200JSONResponse(constantOut(c)), nil
}

// inUse answers an archive refused because something live uses the thing,
// naming what does.
func inUse(err error) error {
	var e *store.InUseError
	if !errors.As(err, &e) {
		return err
	}
	return &problem{status: http.StatusConflict, code: "in_use", detail: "It's in use, so it can't be archived: " + usedBy(e) + "."}
}

// usedBy names what uses something, and at which revisions or versions:
// "Orders at revisions 2 and 4; the upstream CRM at version 1".
func usedBy(e *store.InUseError) string {
	at := func(noun string, ns []int) string {
		said := make([]string, len(ns))
		for i, n := range ns {
			said[i] = strconv.Itoa(n)
		}
		if len(said) > 1 {
			noun += "s"
		}
		return noun + " " + and(said)
	}
	var said []string
	for _, w := range e.Workflows {
		said = append(said, w.Name+" at "+at("revision", w.At))
	}
	for _, u := range e.Upstreams {
		said = append(said, "the upstream "+u.Name+" at "+at("version", u.At))
	}
	return strings.Join(said, "; ")
}

// archiveOut is when something was archived, and by what, as the API sends
// them: zero values, left out, unless it's archived.
func archiveOut(at *time.Time, by *store.Provenance) (time.Time, gen.Provenance) {
	if at == nil {
		return time.Time{}, gen.Provenance{}
	}
	return at.UTC(), provenanceOut(*by)
}
