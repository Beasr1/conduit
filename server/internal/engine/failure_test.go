package engine

import (
	"errors"
	"fmt"
	"testing"

	"github.com/Beasr1/conduit/server/internal/upstream"
)

func TestClassify(t *testing.T) {
	t.Parallel()
	tests := []struct {
		err  error
		want string
	}{
		{&upstream.Error{Kind: upstream.KindStatus, Status: 503}, CodeUpstream},
		{&upstream.Error{Kind: upstream.KindTransport}, CodeUpstream},
		{&upstream.Error{Kind: upstream.KindBlocked}, CodeUpstream},
		{&upstream.Error{Kind: upstream.KindTooLarge}, CodeUpstream},
		{&upstream.Error{Kind: upstream.KindTimeout}, CodeTimeout},
		{fmt.Errorf("%w (30s)", ErrRunTimeout), CodeTimeout},
		{&PanicError{Value: "boom"}, CodeInternal},
		{fmt.Errorf("body: %w", errors.New("D3030: unable to cast")), CodeWorkflow},
	}
	for _, tt := range tests {
		if got := Classify(tt.err); got != tt.want {
			t.Errorf("Classify(%v) = %s, want %s", tt.err, got, tt.want)
		}
	}
}
