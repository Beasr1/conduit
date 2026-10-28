// Package httpapi is the HTTP layer: the handlers for the interface
// generated from schema/openapi.yaml, the token check, body limits, and
// problem details. Every error leaves through answerError, the one place
// that maps errors to statuses.
package httpapi

import (
	"cmp"
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/runner"
	"github.com/Beasr1/conduit/server/internal/store"
)

// maxBody is nginx's client_max_body_size too.
const maxBody = 1 << 20

// Deps is what the HTTP layer needs.
type Deps struct {
	Store      *store.Store
	Runner     *runner.Runner
	Token      string // CONDUIT_API_TOKEN
	Log        *slog.Logger
	MaxStreams int // run event streams open at once; default 256
}

// NewRouter returns the server's handler.
func NewRouter(d Deps) http.Handler {
	a := &api{store: d.Store, runner: d.Runner, log: d.Log, streams: make(chan struct{}, cmp.Or(d.MaxStreams, 256))}
	strict := gen.NewStrictHandlerWithOptions(a, nil, gen.StrictHTTPServerOptions{
		RequestErrorHandlerFunc:  a.requestError,
		ResponseErrorHandlerFunc: a.answerError,
	})
	h := gen.HandlerWithOptions(strict, gen.StdHTTPServerOptions{
		BaseRouter: http.NewServeMux(),
		// Each wraps the one before, so the token is checked before the body.
		Middlewares:      []gen.MiddlewareFunc{checkShape, requireToken(d.Token)},
		ErrorHandlerFunc: a.requestError,
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxBody)
		h.ServeHTTP(w, r)
	})
}

type api struct {
	store  *store.Store
	runner *runner.Runner
	log    *slog.Logger
	// streams holds a token for each open event stream. Each costs a
	// connection and a goroutine for as long as its run goes on.
	streams chan struct{}
}

func (*api) GetHealthz(context.Context, gen.GetHealthzRequestObject) (gen.GetHealthzResponseObject, error) {
	return gen.GetHealthz200JSONResponse{Status: "ok"}, nil
}

func (a *api) GetReadyz(ctx context.Context, _ gen.GetReadyzRequestObject) (gen.GetReadyzResponseObject, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := a.store.Ping(ctx); err != nil {
		a.log.WarnContext(ctx, "not ready", "err", err)
		return nil, &problem{status: http.StatusServiceUnavailable, code: "not_ready", detail: "The database isn't answering."}
	}
	return gen.GetReadyz200JSONResponse{Status: "ok"}, nil
}
