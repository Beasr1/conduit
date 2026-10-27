package runner

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Beasr1/conduit/server/internal/engine"
	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/upstream"
)

// Codes say why a run or a node didn't succeed, and whose fault it was.
const (
	CodeUpstream  = "upstream_failed" // an upstream failed: a status, the connection, its body, or a blocked address
	CodeTimeout   = "timeout"         // the run, or a node's last attempt, ran out of time
	CodeWorkflow  = "workflow_error"  // the workflow's own configuration: an expression, a template
	CodeInternal  = "internal_error"  // our bug: details only in the log
	CodeCancelled = "cancelled"       // the caller went away, or the server shut down
)

// internalDetail is all a client learns about our bug.
const internalDetail = "Something went wrong on our side."

// Failure is why a run or a node didn't succeed, as recorded and streamed.
type Failure struct {
	Code   string `json:"code"`
	Detail string `json:"detail"`
	Node   string `json:"node,omitempty"` // on a run's failure: the node that failed it
}

// classify says whose fault err, a node's or a run's failure, is.
func classify(err error) string {
	var ue *upstream.Error
	var pe *engine.PanicError
	switch {
	case errors.As(err, &pe):
		return CodeInternal
	case errors.Is(err, engine.ErrRunTimeout):
		return CodeTimeout
	case errors.As(err, &ue):
		if ue.Kind == upstream.KindTimeout {
			return CodeTimeout
		}
		return CodeUpstream
	default:
		return CodeWorkflow
	}
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
		Status    int               `json:"status,omitempty"`  // http nodes
		Headers   map[string]string `json:"headers,omitempty"` // http nodes
		Body      json.RawMessage   `json:"body"`              // null when there was none
		Truncated bool              `json:"truncated,omitempty"`
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
	// An http node got an answer, or a transform node gave a value.
	if res.HTTPStatus != 0 || res.Body != nil {
		d := responseDoc{Status: res.HTTPStatus, Body: json.RawMessage("null")}
		if res.HTTPStatus != 0 {
			d.Headers = headersDoc(res.Header)
		}
		if res.Body != nil {
			d.Body, d.Truncated = capped(res.Body)
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
	return rec, nil
}
