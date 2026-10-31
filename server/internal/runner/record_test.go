package runner

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"
)

// A served run that failed answers with its cause's status, its unhandled
// body or its problem alike.
func TestStatus(t *testing.T) {
	t.Parallel()
	for code, want := range map[string]int{
		CodeUpstream:  http.StatusBadGateway,
		CodeTimeout:   http.StatusGatewayTimeout,
		CodeWorkflow:  http.StatusInternalServerError,
		CodeInternal:  http.StatusInternalServerError,
		CodeCancelled: http.StatusServiceUnavailable,
	} {
		if got := Status(code); got != want {
			t.Errorf("Status(%s) = %d, want %d", code, got, want)
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
