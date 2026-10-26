package config

import (
	"log/slog"
	"maps"
	"strings"
	"testing"
	"time"
)

const dbURL = "postgres://conduit:pw@127.0.0.1:5432/conduit" //nolint:gosec // G101: a test URL; pw is a placeholder

// env is the smallest valid environment plus extra.
func env(extra map[string]string) func(string) (string, bool) {
	vars := map[string]string{"CONDUIT_DATABASE_URL": dbURL}
	maps.Copy(vars, extra)
	return func(key string) (string, bool) {
		v, ok := vars[key]
		return v, ok
	}
}

func TestLoad_DefaultsWhenUnset(t *testing.T) {
	cfg, err := Load(env(nil))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	want := Config{
		HTTPAddr:        "127.0.0.1:8080",
		LogFormat:       "json",
		LogLevel:        slog.LevelInfo,
		ShutdownTimeout: 20 * time.Second,
		DatabaseURL:     dbURL,
	}
	if cfg != want {
		t.Errorf("Load() = %+v, want %+v", cfg, want)
	}
}

func TestLoad_ReadsEveryVariable(t *testing.T) {
	token := strings.Repeat("t", 32)
	cfg, err := Load(env(map[string]string{
		"CONDUIT_HTTP_ADDR":        ":9090",
		"CONDUIT_LOG_FORMAT":       "text",
		"CONDUIT_LOG_LEVEL":        "debug",
		"CONDUIT_SHUTDOWN_TIMEOUT": "5s",
		"CONDUIT_API_TOKEN":        token,
	}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	want := Config{
		HTTPAddr:        ":9090",
		LogFormat:       "text",
		LogLevel:        slog.LevelDebug,
		ShutdownTimeout: 5 * time.Second,
		DatabaseURL:     dbURL,
		APIToken:        token,
	}
	if cfg != want {
		t.Errorf("Load() = %+v, want %+v", cfg, want)
	}
}

func TestLoad_RejectsInvalidValues(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		wantErr string
	}{
		{"empty address", map[string]string{"CONDUIT_HTTP_ADDR": ""}, "CONDUIT_HTTP_ADDR"},
		{"unknown log format", map[string]string{"CONDUIT_LOG_FORMAT": "xml"}, "CONDUIT_LOG_FORMAT"},
		{"unknown log level", map[string]string{"CONDUIT_LOG_LEVEL": "loud"}, "CONDUIT_LOG_LEVEL"},
		{"unparsable timeout", map[string]string{"CONDUIT_SHUTDOWN_TIMEOUT": "soon"}, "CONDUIT_SHUTDOWN_TIMEOUT"},
		{"zero timeout", map[string]string{"CONDUIT_SHUTDOWN_TIMEOUT": "0s"}, "must be positive"},
		{"no database", map[string]string{"CONDUIT_DATABASE_URL": ""}, "CONDUIT_DATABASE_URL"},
		{"not a postgres url", map[string]string{"CONDUIT_DATABASE_URL": "mysql://x/y"}, "CONDUIT_DATABASE_URL"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := Load(env(tt.env))
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("Load() error = %v, want one mentioning %q", err, tt.wantErr)
			}
		})
	}
}

func TestLoad_KeepsTheDatabasePasswordOutOfErrors(t *testing.T) {
	_, err := Load(env(map[string]string{"CONDUIT_DATABASE_URL": "mysql://u:s3cret@x/y"})) //nolint:gosec // G101: the fake password is what the test looks for
	if err == nil || strings.Contains(err.Error(), "s3cret") {
		t.Errorf("Load() error = %v; want one without the password", err)
	}
}

func TestLoad_ReportsEveryProblemAtOnce(t *testing.T) {
	_, err := Load(env(map[string]string{
		"CONDUIT_HTTP_ADDR":  "",
		"CONDUIT_LOG_FORMAT": "xml",
	}))
	for _, want := range []string{"CONDUIT_HTTP_ADDR", "CONDUIT_LOG_FORMAT"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Load() error = %v, want it to mention %s", err, want)
		}
	}
}

func TestCheckServe_WantsALongToken(t *testing.T) {
	for token, ok := range map[string]bool{"": false, "short": false, strings.Repeat("x", 32): true} {
		cfg, err := Load(env(map[string]string{"CONDUIT_API_TOKEN": token}))
		if err != nil {
			t.Fatal(err)
		}
		if err := cfg.CheckServe(); (err == nil) != ok {
			t.Errorf("CheckServe() with a %d-character token = %v, want ok=%v", len(token), err, ok)
		}
	}
}
