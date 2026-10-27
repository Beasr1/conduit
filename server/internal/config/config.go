// Package config loads the server's settings from environment variables. It
// owns every variable name; main hands it os.LookupEnv.
//
// Variables:
//
//	CONDUIT_DATABASE_URL      required: postgres://user:password@host:port/database
//	CONDUIT_API_TOKEN         required to serve: the one bearer token (D12), 32+ characters
//	CONDUIT_HTTP_ADDR         listen address, default 127.0.0.1:8080
//	CONDUIT_LOG_FORMAT        json (default) or text
//	CONDUIT_LOG_LEVEL         debug, info (default), warn or error
//	CONDUIT_SHUTDOWN_TIMEOUT  how long shutdown waits for requests, default 20s
//	CONDUIT_ALLOW_PRIVATE_NETWORKS  true lets workflows call private and loopback
//	                          addresses: local development only. Default false
//	CONDUIT_UPSTREAM_PORTS    the ports workflows may call, default 80,443
//	CONDUIT_MAX_RUNS          runs in progress at once, default 32
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Config is the server's settings.
type Config struct {
	HTTPAddr        string
	LogFormat       string
	LogLevel        slog.Level
	ShutdownTimeout time.Duration
	DatabaseURL     string
	APIToken        string

	AllowPrivateNetworks bool
	UpstreamPorts        []uint16
	MaxRuns              int
}

// Load reads the settings through lookup, which is os.LookupEnv in main and a
// map in tests, then validates them.
func Load(lookup func(string) (string, bool)) (Config, error) {
	// Localhost by default: a server that calls arbitrary URLs must not be
	// reachable from the network by accident.
	cfg := Config{
		HTTPAddr:        "127.0.0.1:8080",
		LogFormat:       "json",
		LogLevel:        slog.LevelInfo,
		ShutdownTimeout: 20 * time.Second,
		UpstreamPorts:   []uint16{80, 443},
		MaxRuns:         32,
	}

	var errs []error
	cfg.DatabaseURL, _ = lookup("CONDUIT_DATABASE_URL")
	cfg.APIToken, _ = lookup("CONDUIT_API_TOKEN")
	if v, ok := lookup("CONDUIT_HTTP_ADDR"); ok {
		cfg.HTTPAddr = v
	}
	if v, ok := lookup("CONDUIT_LOG_FORMAT"); ok {
		cfg.LogFormat = v
	}
	if v, ok := lookup("CONDUIT_LOG_LEVEL"); ok {
		if err := cfg.LogLevel.UnmarshalText([]byte(v)); err != nil {
			errs = append(errs, fmt.Errorf("CONDUIT_LOG_LEVEL: %w", err))
		}
	}
	if v, ok := lookup("CONDUIT_SHUTDOWN_TIMEOUT"); ok {
		d, err := time.ParseDuration(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("CONDUIT_SHUTDOWN_TIMEOUT: %w", err))
		}
		cfg.ShutdownTimeout = d
	}
	if v, ok := lookup("CONDUIT_ALLOW_PRIVATE_NETWORKS"); ok {
		b, err := strconv.ParseBool(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("CONDUIT_ALLOW_PRIVATE_NETWORKS: %q is not true or false", v))
		}
		cfg.AllowPrivateNetworks = b
	}
	if v, ok := lookup("CONDUIT_UPSTREAM_PORTS"); ok {
		ports, err := parsePorts(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("CONDUIT_UPSTREAM_PORTS: %w", err))
		}
		cfg.UpstreamPorts = ports
	}
	if v, ok := lookup("CONDUIT_MAX_RUNS"); ok {
		n, err := strconv.Atoi(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("CONDUIT_MAX_RUNS: %q is not a whole number", v))
		}
		cfg.MaxRuns = n
	}
	if err := errors.Join(errs...); err != nil {
		return Config{}, err
	}
	return cfg, cfg.Validate()
}

// Validate reports every invalid setting at once.
func (c Config) Validate() error {
	var errs []error
	if c.HTTPAddr == "" {
		errs = append(errs, errors.New("CONDUIT_HTTP_ADDR: must not be empty"))
	}
	if c.LogFormat != "json" && c.LogFormat != "text" {
		errs = append(errs, fmt.Errorf("CONDUIT_LOG_FORMAT: %q is not json or text", c.LogFormat))
	}
	if c.ShutdownTimeout <= 0 {
		errs = append(errs, fmt.Errorf("CONDUIT_SHUTDOWN_TIMEOUT: %s must be positive", c.ShutdownTimeout))
	}
	if len(c.UpstreamPorts) == 0 {
		errs = append(errs, errors.New("CONDUIT_UPSTREAM_PORTS: name at least one port"))
	}
	if c.MaxRuns < 1 {
		errs = append(errs, fmt.Errorf("CONDUIT_MAX_RUNS: %d must be at least 1", c.MaxRuns))
	}
	if u, err := url.Parse(c.DatabaseURL); c.DatabaseURL == "" || err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		// The value isn't echoed: it holds the database password.
		errs = append(errs, errors.New("CONDUIT_DATABASE_URL: required, as postgres://user:password@host:port/database"))
	}
	return errors.Join(errs...)
}

// CheckServe reports what serving needs beyond Validate: the API token. A
// short token is refused, since it's the only thing guarding the server.
func (c Config) CheckServe() error {
	if len(c.APIToken) < 32 {
		return errors.New("CONDUIT_API_TOKEN: required, at least 32 characters (try: openssl rand -hex 32)")
	}
	return nil
}

// parsePorts reads a comma-separated list of ports, such as 80,443.
func parsePorts(v string) ([]uint16, error) {
	var ports []uint16
	for f := range strings.SplitSeq(v, ",") {
		n, err := strconv.ParseUint(strings.TrimSpace(f), 10, 16)
		if err != nil || n == 0 {
			return nil, fmt.Errorf("%q is not a port", strings.TrimSpace(f))
		}
		ports = append(ports, uint16(n))
	}
	return ports, nil
}
