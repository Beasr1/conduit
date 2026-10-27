package runner

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/Beasr1/conduit/server/internal/engine"
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
		{fmt.Errorf("%w (30s)", engine.ErrRunTimeout), CodeTimeout},
		{&engine.PanicError{Value: "boom"}, CodeInternal},
		{fmt.Errorf("body: %w", errors.New("D3030: unable to cast")), CodeWorkflow},
	}
	for _, tt := range tests {
		if got := classify(tt.err); got != tt.want {
			t.Errorf("classify(%v) = %s, want %s", tt.err, got, tt.want)
		}
	}
}

func TestCapped(t *testing.T) {
	t.Parallel()
	small := json.RawMessage(`{"a": 1}`)
	if got, cut := capped(small); string(got) != string(small) || cut {
		t.Errorf("capped(small) = %s, %v", got, cut)
	}
	// A three-byte character straddles the cap, so the cut backs off to
	// before it.
	big := json.RawMessage(`"` + strings.Repeat("a", maxStored-2) + "€€" + `"`)
	got, cut := capped(big)
	var s string
	if err := json.Unmarshal(got, &s); err != nil || !cut {
		t.Fatalf("capped(big) = %d bytes, %v, %v; want a JSON string", len(got), cut, err)
	}
	if want := `"` + strings.Repeat("a", maxStored-2); s != want || !utf8.ValidString(s) {
		t.Errorf("preview ends %q, want it to stop before the €", s[len(s)-5:])
	}
}

func TestRedactURL(t *testing.T) {
	t.Parallel()
	tests := []struct{ in, want string }{
		{"https://api.example.com/v1/users/7", "https://api.example.com/v1/users/7"},
		{
			"https://api.example.com/x?page=2&api_key=k-1&Access_Token=t&%74oken=e&q=a%20b",
			"https://api.example.com/x?page=2&api_key=[redacted]&Access_Token=[redacted]&%74oken=[redacted]&q=a%20b",
		},
		{"https://ada:hunter2@api.example.com/", "https://ada:redacted@api.example.com/"},
		{"https://api.example.com/%2Fkept?password", "https://api.example.com/%2Fkept?password=[redacted]"},
	}
	for _, tt := range tests {
		if got := redactURL(tt.in); got != tt.want {
			t.Errorf("redactURL(%q)\n got %q\nwant %q", tt.in, got, tt.want)
		}
	}
}

func TestHeadersDoc(t *testing.T) {
	t.Parallel()
	h := http.Header{
		"Authorization":   {"Bearer s3cret"},
		"X-Api-Key":       {"k"},
		"Set-Cookie":      {"a=1", "b=2"},
		"X-Client-Secret": {"s"},
		"Accept":          {"application/json", "text/plain"},
	}
	got := headersDoc(h)
	want := map[string]string{
		"authorization":   redacted,
		"x-api-key":       redacted,
		"set-cookie":      redacted,
		"x-client-secret": redacted,
		"accept":          "application/json, text/plain",
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("headersDoc() = %v, want %v", got, want)
	}
}
