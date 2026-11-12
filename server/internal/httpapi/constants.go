package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"unicode/utf8"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/transform"
)

// Constants (plan 06): named values every expression reads as $const.name,
// changed in one place for every run from then on. A secret one's value
// comes in and never goes out.

// constantName is a constant's name, as a parameter's is (plan 07).
var constantName = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

const maxConstantValue = 4096

// constantProblems is what's wrong with a constant's name, when it has one
// to check, and its value.
func constantProblems(name *string, value string) error {
	var errs []gen.ProblemError
	if name != nil && !constantName.MatchString(*name) {
		errs = append(errs, gen.ProblemError{Pointer: "/name", Code: "invalid_name", Detail: "a name is a lower-case letter, then up to 63 lower-case letters, digits and underscores"})
	}
	if n := utf8.RuneCountInString(value); n < 1 || n > maxConstantValue {
		errs = append(errs, gen.ProblemError{Pointer: "/value", Code: "invalid_value", Detail: fmt.Sprintf("a value is 1 to %d characters", maxConstantValue)})
	}
	if len(errs) == 0 {
		return nil
	}
	return &problem{
		status: http.StatusUnprocessableEntity, code: "invalid_request",
		detail: "The request has problems; nothing was saved.", errors: errs,
	}
}

func (a *api) ListConstants(ctx context.Context, req gen.ListConstantsRequestObject) (gen.ListConstantsResponseObject, error) {
	cs, err := a.store.Constants(ctx)
	if err != nil {
		return nil, err
	}
	out := gen.ListConstants200JSONResponse{Constants: make([]gen.Constant, 0, len(cs))}
	for _, c := range cs {
		if (c.ArchivedAt != nil) == req.Params.Archived {
			out.Constants = append(out.Constants, constantOut(c))
		}
	}
	return out, nil
}

func (a *api) CreateConstant(ctx context.Context, req gen.CreateConstantRequestObject) (gen.CreateConstantResponseObject, error) {
	b := req.Body
	if err := constantProblems(&b.Name, b.Value); err != nil {
		return nil, err
	}
	c, err := a.store.CreateConstant(ctx, b.Name, b.Value, b.Secret, provenance(ctx))
	if errors.Is(err, store.ErrArchivedName) {
		return nil, &problem{status: http.StatusConflict, code: "conflict", detail: "An archived constant has that name: restore it, or pick another."}
	}
	if errors.Is(err, store.ErrConflict) {
		return nil, &problem{status: http.StatusConflict, code: "conflict", detail: "A constant already has that name."}
	}
	if err != nil {
		return nil, err
	}
	return gen.CreateConstant201JSONResponse{
		Body:    constantOut(c),
		Headers: gen.CreateConstant201ResponseHeaders{Location: "/v1/constants/" + c.Name},
	}, nil
}

func (a *api) SetConstant(ctx context.Context, req gen.SetConstantRequestObject) (gen.SetConstantResponseObject, error) {
	if err := constantProblems(nil, req.Body.Value); err != nil {
		return nil, err
	}
	c, err := a.store.SetConstant(ctx, req.Name, req.Body.Value, req.Body.Secret, provenance(ctx))
	if err != nil {
		return nil, noConstant(err)
	}
	return gen.SetConstant200JSONResponse(constantOut(c)), nil
}

func (a *api) UndoConstant(ctx context.Context, req gen.UndoConstantRequestObject) (gen.UndoConstantResponseObject, error) {
	c, err := a.store.UndoConstant(ctx, req.Name, provenance(ctx))
	if errors.Is(err, store.ErrNothingToUndo) {
		return nil, &problem{status: http.StatusConflict, code: "nothing_to_undo", detail: "Its value hasn't changed since it was made, so there's nothing to put back."}
	}
	if err != nil {
		return nil, noConstant(err)
	}
	return gen.UndoConstant200JSONResponse(constantOut(c)), nil
}

func (a *api) ListConstantUsers(ctx context.Context, req gen.ListConstantUsersRequestObject) (gen.ListConstantUsersResponseObject, error) {
	us, err := a.store.ConstantUsers(ctx, req.Name)
	if err != nil {
		return nil, noConstant(err)
	}
	out := gen.ListConstantUsers200JSONResponse{
		Workflows: make([]gen.ConstantWorkflowUse, 0, len(us.Workflows)),
		Upstreams: make([]gen.ConstantUpstreamUse, 0, len(us.Upstreams)),
	}
	for _, w := range us.Workflows {
		for _, revision := range w.At {
			out.Workflows = append(out.Workflows, gen.ConstantWorkflowUse{WorkflowID: w.ID, Name: w.Name, Revision: revision})
		}
	}
	// Each upstream's one version: its latest.
	for _, u := range us.Upstreams {
		out.Upstreams = append(out.Upstreams, gen.ConstantUpstreamUse{UpstreamID: u.ID, Name: u.Name, Version: u.At[0]})
	}
	return out, nil
}

// standIns is each constant's value for a preview: a plain one's own, and
// a secret one's stand-in.
func standIns(cs []store.Constant) map[string]string {
	out := make(map[string]string, len(cs))
	for _, c := range cs {
		out[c.Name] = c.Value
		if c.Secret {
			out[c.Name] = transform.StandIn(c.Name)
		}
	}
	return out
}

func noConstant(err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return &problem{status: http.StatusNotFound, code: "not_found", detail: "There's no such constant."}
	}
	return err
}

// constantOut is a constant as the API sends it: a secret one without its
// value.
func constantOut(c store.Constant) gen.Constant {
	out := gen.Constant{
		Name: c.Name, Secret: c.Secret, HasPrevious: c.HasPrevious,
		Provenance: provenanceOut(c.Provenance), UpdatedAt: c.UpdatedAt.UTC(), CreatedAt: c.CreatedAt.UTC(),
	}
	out.ArchivedAt, out.ArchivedBy = archiveOut(c.ArchivedAt, c.ArchivedBy)
	if !c.Secret {
		out.Value = c.Value
	}
	return out
}
