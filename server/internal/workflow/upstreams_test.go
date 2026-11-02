package workflow

import (
	"encoding/json"
	"strings"
	"testing"
)

func decodeUpstream(t *testing.T, doc string) *Upstream {
	t.Helper()
	var u Upstream
	if err := json.Unmarshal([]byte(doc), &u); err != nil {
		t.Fatalf("decode %s: %v", doc, err)
	}
	return &u
}

// An upstream's version is checked as an http node is, its request,
// responses and samples, and its parameters are named as ids are, once
// each (plan 07).
func TestValidateUpstream(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, doc, want string
	}{
		{
			"one that's whole",
			`{"parameters": [{"name": "user_id"}], "request": {"method": "GET", "url": "https://users.example.com/v1/users/{{ user_id }}"},
			  "sample": {"body": {"id": "7"}}, "outputs": [{"status": 404, "sample": {"body": null}}]}`,
			"",
		},
		{
			"parameters named badly, or twice",
			`{"parameters": [{"name": ""}, {"name": "User"}, {"name": "id"}, {"name": "id"}], "request": {"method": "GET", "url": "https://users.example.com/v1"}}`,
			"/parameters/0/name required\n/parameters/1/name invalid_name\n/parameters/3/name duplicate_parameter",
		},
		{
			"a request as an http node's",
			`{"request": {"method": "", "url": "", "headers": {"X Bad": "1"}, "timeout_ms": -1}}`,
			"/request/headers/X Bad invalid_header_name\n/request/method required\n/request/timeout_ms invalid_timeout\n/request/url required",
		},
		{
			"responses and samples as an http node's",
			`{"request": {"method": "GET", "url": "https://users.example.com/v1"}, "sample": {"status": 404, "body": null},
			  "outputs": [{"status": 200}, {"status": 404}, {"status": 404}]}`,
			"/outputs/0/status invalid_status\n/outputs/2/status duplicate_output\n/sample/status invalid_status",
		},
		{
			"a parameter's sample over 64 KiB",
			`{"parameters": [{"name": "a", "sample": "` + strings.Repeat("x", 64<<10) + `"}], "request": {"method": "GET", "url": "https://x.example.com"}}`,
			"/parameters/0/sample too_large",
		},
		{
			// Conduit sets W3C trace context on every call (plan 06).
			"a header Conduit sets",
			`{"request": {"method": "GET", "url": "https://users.example.com/v1", "headers": {"Traceparent": "x"}}}`,
			"/request/headers/Traceparent reserved_header",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := found(ValidateUpstream(decodeUpstream(t, tt.doc))); got != tt.want {
				t.Errorf("ValidateUpstream() =\n%s\nwant\n%s", got, tt.want)
			}
		})
	}
}
