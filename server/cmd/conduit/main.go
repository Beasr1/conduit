// Command conduit runs the Conduit API server.
//
//	conduit                  serve the API (the same as `conduit serve`)
//	conduit migrate [up]     apply pending database migrations
//	conduit migrate down     undo the latest migration
//	conduit migrate status   list migrations and whether each is applied
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Beasr1/conduit/server/internal/config"
	"github.com/Beasr1/conduit/server/internal/httpapi"
	"github.com/Beasr1/conduit/server/internal/runner"
	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/upstream"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "conduit:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	cfg, err := config.Load(os.LookupEnv)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch {
	case len(args) == 0 || args[0] == "serve":
		return serve(ctx, stop, cfg)
	case args[0] == "migrate":
		command := "up"
		if len(args) > 1 {
			command = args[1]
		}
		return store.Migrate(ctx, cfg.DatabaseURL, command, os.Stdout)
	default:
		return fmt.Errorf("unknown command %q: use serve or migrate", args[0])
	}
}

func serve(ctx context.Context, stop context.CancelFunc, cfg config.Config) error {
	if err := cfg.CheckServe(); err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	log := newLogger(cfg)
	db, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer db.Close() // after the server has stopped, below

	if cfg.AllowPrivateNetworks {
		log.Warn("workflows may call private and loopback addresses: CONDUIT_ALLOW_PRIVATE_NETWORKS is for local development only")
	}
	client := upstream.New(upstream.Options{AllowPrivateNetworks: cfg.AllowPrivateNetworks, Ports: cfg.UpstreamPorts})
	runs := runner.New(db, client, log, runner.Options{MaxRuns: cfg.MaxRuns})
	// Before serving, so every run still marked running is a stopped
	// process's, never this one's.
	if err := runs.Recover(ctx); err != nil {
		return err
	}

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           httpapi.NewRouter(httpapi.Deps{Store: db, Runner: runs, Token: cfg.APIToken, Log: log}),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		// Just above the 30 s default for served runs (roadmap, execution
		// item 10), so their 504 gets out before the connection is cut.
		WriteTimeout: 35 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	serveErr := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.HTTPAddr)
		serveErr <- srv.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		return fmt.Errorf("serve: %w", err)
	case <-ctx.Done():
	}
	stop() // a second Ctrl-C now kills the process instead of waiting

	log.Info("shutting down", "timeout", cfg.ShutdownTimeout)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	// Shutdown waits for every request, and an editor run's event stream
	// lasts as long as the run, so those runs are cancelled first. Served
	// runs finish: their callers are waiting.
	runs.Stop()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	// The cancelled runs record how they ended before the database closes.
	if err := runs.Wait(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	if err := <-serveErr; !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve: %w", err)
	}
	return nil
}

func newLogger(cfg config.Config) *slog.Logger {
	opts := &slog.HandlerOptions{Level: cfg.LogLevel}
	if cfg.LogFormat == "text" {
		return slog.New(slog.NewTextHandler(os.Stderr, opts))
	}
	return slog.New(slog.NewJSONHandler(os.Stderr, opts))
}
