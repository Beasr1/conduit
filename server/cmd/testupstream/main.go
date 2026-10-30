// Command testupstream is an upstream to try runs against: it answers a few
// known requests the same way every time, so a run can take each branch on
// cue. It's for development and tests only, and the server reaches it only
// with CONDUIT_ALLOW_PRIVATE_NETWORKS, since it listens on loopback.
//
//	GET  /users/{id}     a user, 1 to 9; any other id is 404
//	POST /users          201, the user created from the body
//	GET  /orders         a user's orders, by ?user_id
//	GET  /prefs/{id}     a user's preferences
//	POST /contacts       201, a contact created from the body
//	GET  /slow           200 after ?ms milliseconds, at most 30000
//	GET  /status/{code}  that status, 200 to 599
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8090", "the address to listen on")
	flag.Parse()
	if err := serve(*addr); err != nil {
		fmt.Fprintln(os.Stderr, "testupstream:", err)
		os.Exit(1)
	}
}

func serve(addr string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	srv := &http.Server{Addr: addr, Handler: logged(handler()), ReadHeaderTimeout: 5 * time.Second}
	failed := make(chan error, 1)
	go func() { failed <- srv.ListenAndServe() }()
	slog.Info("test upstream listening", "addr", "http://"+addr)
	select {
	case err := <-failed:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /users/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if n, err := strconv.Atoi(id); err != nil || n < 1 || n > 9 {
			reply(w, http.StatusNotFound, map[string]any{"error": "not found"})
			return
		}
		reply(w, http.StatusOK, map[string]any{"id": id, "name": "User " + id, "email": "user" + id + "@example.com"})
	})
	mux.HandleFunc("POST /users", func(w http.ResponseWriter, r *http.Request) {
		created := map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&created) // a body that isn't JSON creates a user with no fields
		created["id"] = "10"
		reply(w, http.StatusCreated, created)
	})
	mux.HandleFunc("GET /orders", func(w http.ResponseWriter, r *http.Request) {
		user := r.URL.Query().Get("user_id")
		reply(w, http.StatusOK, map[string]any{"orders": []map[string]any{
			{"id": "o-1", "user_id": user, "total": 25},
			{"id": "o-2", "user_id": user, "total": 40},
		}})
	})
	mux.HandleFunc("GET /prefs/{id}", func(w http.ResponseWriter, r *http.Request) {
		reply(w, http.StatusOK, map[string]any{"user_id": r.PathValue("id"), "newsletter": true, "language": "en"})
	})
	mux.HandleFunc("POST /contacts", func(w http.ResponseWriter, r *http.Request) {
		created := map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&created) // as for users
		created["id"] = "c-1"
		reply(w, http.StatusCreated, created)
	})
	mux.HandleFunc("GET /slow", func(w http.ResponseWriter, r *http.Request) {
		ms, err := strconv.Atoi(r.URL.Query().Get("ms"))
		if err != nil || ms < 0 || ms > 30000 {
			ms = 2000
		}
		wait := time.Duration(ms) * time.Millisecond
		select {
		case <-time.After(wait):
			reply(w, http.StatusOK, map[string]any{"slept": wait.String()})
		case <-r.Context().Done():
		}
	})
	mux.HandleFunc("GET /status/{code}", func(w http.ResponseWriter, r *http.Request) {
		code, err := strconv.Atoi(r.PathValue("code"))
		if err != nil || code < 200 || code > 599 {
			reply(w, http.StatusBadRequest, map[string]any{"error": "a status from 200 to 599"})
			return
		}
		reply(w, code, map[string]any{"error": http.StatusText(code)})
	})
	return mux
}

func reply(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body) // the status is out, so a failed write can't change the answer
}

// logged logs each request as it's answered, so a run's calls show where
// the test upstream runs.
func logged(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &status{ResponseWriter: w, code: http.StatusOK}
		next.ServeHTTP(rec, r)
		slog.Info("answered", "method", r.Method, "path", r.URL.Path, "status", rec.code)
	})
}

type status struct {
	http.ResponseWriter
	code int
}

func (s *status) WriteHeader(code int) {
	s.code = code
	s.ResponseWriter.WriteHeader(code)
}
