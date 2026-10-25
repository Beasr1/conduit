// Package httpapi holds the HTTP routes and handlers. It translates between
// HTTP and the rest of the server; nothing below it knows about requests.
// Routes and types are generated from schema/openapi.yaml into gen/.
package httpapi

import (
	"context"
	"net/http"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
)

// NewRouter returns the server's routes.
func NewRouter() http.Handler {
	mux := http.NewServeMux()
	gen.HandlerFromMux(gen.NewStrictHandler(api{}, nil), mux)
	return mux
}

// api implements the operations in schema/openapi.yaml.
type api struct{}

// GetHealthz reports that the process is up. It checks no dependencies, so a
// slow dependency can't make the process look dead.
func (api) GetHealthz(context.Context, gen.GetHealthzRequestObject) (gen.GetHealthzResponseObject, error) {
	return gen.GetHealthz200JSONResponse{Status: "ok"}, nil
}
