package runner

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Beasr1/conduit/server/internal/engine"
	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// Codes say why a run or a node didn't succeed, and whose fault it was, as
// the engine names them.
const (
	CodeUpstream  = engine.CodeUpstream
	CodeTimeout   = engine.CodeTimeout
	CodeWorkflow  = engine.CodeWorkflow
	CodeInternal  = engine.CodeInternal
	CodeCancelled = engine.CodeCancelled
)

// Status is the HTTP status a served run that failed answers with, by its
// failure's code: an upstream that failed 502, a timeout 504, the
// workflow's own failure or our bug 500. A cancelled run's caller has gone,
// so its 503 is for the access log.
func Status(code string) int {
	switch code {
	case CodeUpstream:
		return http.StatusBadGateway
	case CodeTimeout:
		return http.StatusGatewayTimeout
	case CodeCancelled:
		return http.StatusServiceUnavailable
	default:
		return http.StatusInternalServerError
	}
}

// internalDetail is all a client learns about our bug.
const internalDetail = "Something went wrong on our side."

// Failure is why a run or a node didn't succeed, as recorded and streamed.
type Failure struct {
	Code   string `json:"code"`
	Detail string `json:"detail"`
	Node   string `json:"node,omitempty"` // on a run's failure: the node that failed it
	// On a node's failure: its Unhandled block took it, and the run went on.
	Caught bool `json:"caught,omitempty"`
}

// Way is the edge an either ran with, as the definition writes it, and as
// it's recorded and streamed.
type Way struct {
	From      string `json:"from"`
	On        int    `json:"on,omitempty"`
	Unhandled bool   `json:"unhandled,omitempty"`
}

// wayOf is the engine's way of an either that ran, nil for any other node.
func wayOf(w *engine.Way) *Way {
	switch {
	case w == nil:
		return nil
	case w.On == workflow.OnUnhandled:
		return &Way{From: w.From, Unhandled: true}
	}
	return &Way{From: w.From, On: w.On}
}

// maxStored caps each body as stored (answer 4). The engine itself works
// with bodies up to 10 MiB.
const maxStored = 256 << 10

// capped is body as stored: itself when it fits in 256 KiB, or else its first
// 256 KiB as a JSON string, cut at a character boundary, and true.
func capped(body json.RawMessage) (json.RawMessage, bool) {
	if len(body) <= maxStored {
		return body, false
	}
	n := maxStored
	for n > 0 && !utf8.RuneStart(body[n]) {
		n--
	}
	s, err := json.Marshal(string(body[:n]))
	if err != nil {
		return json.RawMessage("null"), true // unreachable: a string always marshals
	}
	return s, true
}

const redacted = "[redacted]"

// secret says whether a header or query parameter of this name may carry a
// secret, so its value is never stored.
func secret(name string) bool {
	n := strings.ToLower(name)
	switch n {
	case "authorization", "proxy-authorization", "cookie", "set-cookie":
		return true
	}
	for _, s := range []string{"key", "token", "secret", "password"} {
		if strings.Contains(n, s) {
			return true
		}
	}
	return false
}

// headersDoc is h as stored: lower-case names, values joined by commas, as
// in the data document, and secrets redacted.
func headersDoc(h http.Header) map[string]string {
	out := make(map[string]string, len(h))
	for k, v := range h {
		name := strings.ToLower(k)
		if secret(name) {
			out[name] = redacted
		} else {
			out[name] = strings.Join(v, ", ")
		}
	}
	return out
}

// redactURL hides the URL's password, and the values of query parameters
// with secret names. The rest stays as sent, parameter order included.
func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "(unparsable url)"
	}
	if _, ok := u.User.Password(); ok {
		u.User = url.UserPassword(u.User.Username(), "redacted")
	}
	if u.RawQuery != "" {
		pairs := strings.Split(u.RawQuery, "&")
		for i, p := range pairs {
			name, _, _ := strings.Cut(p, "=")
			n, err := url.QueryUnescape(name)
			if err != nil {
				n = name
			}
			if secret(n) {
				pairs[i] = name + "=" + redacted
			}
		}
		u.RawQuery = strings.Join(pairs, "&")
	}
	return u.String()
}

// The stored shapes of what a node sent and got back. They're the API's
// NodeRequest and NodeResponse in schema/openapi.yaml, which the HTTP layer
// decodes them into.
type (
	requestDoc struct {
		Method    string            `json:"method"`
		URL       string            `json:"url"`
		Headers   map[string]string `json:"headers"`
		Body      json.RawMessage   `json:"body,omitempty"`
		Truncated bool              `json:"truncated,omitempty"`
	}
	responseDoc struct {
		Status    int               `json:"status,omitempty"`    // http nodes
		Headers   map[string]string `json:"headers,omitempty"`   // http nodes
		Body      json.RawMessage   `json:"body"`                // null when there was none
		Gave      json.RawMessage   `json:"gave,omitempty"`      // what its Unhandled body gave
		Truncated bool              `json:"truncated,omitempty"` // the body, or what it gave, was capped
	}
)

// nodeEnd is a node's result on its way to the writer.
type nodeEnd struct {
	result    engine.NodeResult
	failure   *Failure // when it failed
	startedAt *time.Time
	endedAt   time.Time
}

// nodeRecord is what's stored for a node: redacted, and bodies capped.
func nodeRecord(runID string, n nodeEnd) (store.NodeRun, error) {
	res := n.result
	rec := store.NodeRun{
		RunID: runID, NodeID: res.ID, Status: string(res.Status), Attempts: res.Attempts,
		StartedAt: n.startedAt, EndedAt: n.endedAt,
	}
	var err error
	if r := res.Request; r != nil {
		d := requestDoc{Method: r.Method, URL: redactURL(r.URL), Headers: headersDoc(r.Header)}
		d.Body, d.Truncated = capped(r.Body)
		if rec.Request, err = json.Marshal(d); err != nil {
			return rec, fmt.Errorf("encode the request: %w", err)
		}
	}
	// An http node got an answer, a transform node gave a value, or an
	// Unhandled body gave one.
	if res.HTTPStatus != 0 || res.Body != nil || res.Gave != nil {
		d := responseDoc{Status: res.HTTPStatus, Body: json.RawMessage("null")}
		if res.HTTPStatus != 0 {
			d.Headers = headersDoc(res.Header)
		}
		if res.Body != nil {
			d.Body, d.Truncated = capped(res.Body)
		}
		if res.Gave != nil {
			var cut bool
			d.Gave, cut = capped(res.Gave)
			d.Truncated = d.Truncated || cut
		}
		if rec.Response, err = json.Marshal(d); err != nil {
			return rec, fmt.Errorf("encode the response: %w", err)
		}
	}
	if n.failure != nil {
		if rec.Error, err = json.Marshal(n.failure); err != nil {
			return rec, fmt.Errorf("encode the error: %w", err)
		}
	}
	if w := wayOf(res.Way); w != nil {
		if rec.Way, err = json.Marshal(w); err != nil {
			return rec, fmt.Errorf("encode the way: %w", err)
		}
	}
	return rec, nil
}
