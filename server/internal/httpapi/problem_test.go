package httpapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// An error answerError doesn't recognise is our bug, unless the client went
// away first: then it's the cancel's doing, and isn't logged as an error.
func TestAnswerError_ClientGoneIsNotOurBug(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name      string
		cancelled bool
		err       error
		level     string
	}{
		{"the client is still there", false, errors.New("list workflows: connection reset"), "level=ERROR"},
		{"the client went away", true, fmt.Errorf("list workflows: %w", context.Canceled), "level=INFO"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var logs bytes.Buffer
			a := &api{log: slog.New(slog.NewTextHandler(&logs, nil))}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if tt.cancelled {
				cancel()
			}
			rec := httptest.NewRecorder()
			a.answerError(rec, httptest.NewRequestWithContext(ctx, http.MethodGet, "/v1/workflows", nil), tt.err)
			if got := logs.String(); strings.Count(got, "\n") != 1 || !strings.Contains(got, tt.level) {
				t.Errorf("logged %q, want one line at %s", got, tt.level)
			}
			if rec.Code != http.StatusInternalServerError {
				t.Errorf("status = %d, want 500", rec.Code)
			}
		})
	}
}
