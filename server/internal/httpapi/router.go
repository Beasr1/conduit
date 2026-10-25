// Package httpapi holds the HTTP routes and handlers. It translates between
// HTTP and the rest of the server; nothing below it knows about requests.
package httpapi

import "net/http"

// NewRouter returns the server's routes.
func NewRouter() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthz)
	return mux
}

// healthz reports that the process is up. It checks no dependencies, so a slow
// dependency can't make the process look dead.
func healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"ok"}` + "\n"))
}
