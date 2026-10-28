package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/store"
)

// problem is an error that's already an HTTP answer: RFC 9457 problem
// details, with every validation problem at once.
type problem struct {
	status int
	code   string
	detail string
	errors []gen.ProblemError

	node       string // the node that failed a served run
	instance   string // the served run that failed, as /v1/runs/{id}
	retryAfter int    // seconds, for a 503
}

func (p *problem) Error() string { return fmt.Sprintf("%d %s: %s", p.status, p.code, p.detail) }

// statuses maps the store's errors to answers. A slice, not a map, so an
// error matching two entries maps the same way every time: first match wins.
var statuses = []struct {
	err    error
	status int
	code   string
	detail string
}{
	{store.ErrNotFound, http.StatusNotFound, "not_found", "There's no such workflow, revision or run."},
	{store.ErrConflict, http.StatusConflict, "conflict", "That slug is taken."},
	{
		store.ErrRevisionMismatch, http.StatusPreconditionFailed, "revision_mismatch",
		"A newer revision was saved first. Fetch it, apply your change to it, and save with its ETag.",
	},
}

// answerError writes err as problem details. An error it doesn't recognise
// is our bug: it's logged, and the client gets a 500 that says nothing more.
func (a *api) answerError(w http.ResponseWriter, r *http.Request, err error) {
	var p *problem
	if !errors.As(err, &p) {
		for _, s := range statuses {
			if errors.Is(err, s.err) {
				p = &problem{status: s.status, code: s.code, detail: s.detail}
				break
			}
		}
	}
	if p == nil {
		// A client that goes away mid-request cancels its context, and the
		// work fails with it: no bug of ours. It still gets the 500 below,
		// which no one reads; returning without one would send an empty 200
		// if the connection were somehow still open.
		if errors.Is(r.Context().Err(), context.Canceled) {
			a.log.InfoContext(r.Context(), "request cancelled by the client", "method", r.Method, "path", r.URL.Path, "err", err)
		} else {
			a.log.ErrorContext(r.Context(), "request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		}
		p = &problem{status: http.StatusInternalServerError, code: "internal_error", detail: "Something went wrong on our side."}
	}
	writeProblem(w, p)
}

// requestError answers a request the generated code couldn't read: bad
// JSON, a parameter of the wrong type, or a body over the limit.
func (a *api) requestError(w http.ResponseWriter, _ *http.Request, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeProblem(w, &problem{
			status: http.StatusRequestEntityTooLarge, code: "too_large",
			detail: fmt.Sprintf("The body is over %d bytes.", tooLarge.Limit),
		})
		return
	}
	writeProblem(w, &problem{status: http.StatusBadRequest, code: "invalid_request", detail: err.Error()})
}

func writeProblem(w http.ResponseWriter, p *problem) {
	w.Header().Set("Content-Type", "application/problem+json")
	if p.retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(p.retryAfter))
	}
	w.WriteHeader(p.status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false) // keep <token> readable, not \u003ctoken\u003e
	// The status line is already out, so an encoding error can't change the
	// answer; there's nothing useful to do with it.
	_ = enc.Encode(gen.Problem{
		Status:   p.status,
		Title:    http.StatusText(p.status),
		Code:     p.code,
		Detail:   p.detail,
		Errors:   p.errors,
		Node:     p.node,
		Instance: p.instance,
	})
}
