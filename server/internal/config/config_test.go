package config

import (
	"log/slog"
	"strings"
	"testing"
	"time"
)

func lookupFrom(env map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		v, ok := env[key]
		return v, ok
	}
}

func TestLoad_DefaultsWhenUnset(t *testing.T) {
	cfg, err := Load(lookupFrom(nil))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	want := Config{
		HTTPAddr:        "127.0.0.1:8080",
		LogFormat:       "json",
		LogLevel:        slog.LevelInfo,
		ShutdownTimeout: 20 * time.Second,
	}
	if cfg != want {
		t.Errorf("Load() = %+v, want %+v", cfg, want)
	}
}

func TestLoad_ReadsEveryVariable(t *testing.T) {
	cfg, err := Load(lookupFrom(map[string]string{
		"CONDUIT_HTTP_ADDR":        ":9090",
		"CONDUIT_LOG_FORMAT":       "text",
		"CONDUIT_LOG_LEVEL":        "debug",
		"CONDUIT_SHUTDOWN_TIMEOUT": "5s",
	}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	want := Config{
		HTTPAddr:        ":9090",
		LogFormat:       "text",
		LogLevel:        slog.LevelDebug,
		ShutdownTimeout: 5 * time.Second,
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
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := Load(lookupFrom(tt.env))
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("Load() error = %v, want one mentioning %q", err, tt.wantErr)
			}
		})
	}
}

func TestLoad_ReportsEveryProblemAtOnce(t *testing.T) {
	_, err := Load(lookupFrom(map[string]string{
		"CONDUIT_HTTP_ADDR":  "",
		"CONDUIT_LOG_FORMAT": "xml",
	}))
	for _, want := range []string{"CONDUIT_HTTP_ADDR", "CONDUIT_LOG_FORMAT"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Load() error = %v, want it to mention %s", err, want)
		}
	}
}
