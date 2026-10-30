package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"runtime/debug"
	"slices"
	"strings"

	"github.com/Beasr1/conduit/server/internal/upstream"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// maxDocument caps the data document a node's expressions see. A complex
// expression decodes all of it, so this bounds that work.
const maxDocument = 16 << 20

type docPart struct {
	id    string
	entry json.RawMessage
}

// document builds {"input": …, "nodes": {"<id>": entry, …}}. Node ids are
// plain identifiers, so they need no escaping.
func document(input json.RawMessage, parts []docPart) ([]byte, error) {
	size := len(`{"input":,"nodes":{}}`) + len(input)
	for _, p := range parts {
		size += len(`,"":`) + len(p.id) + len(p.entry)
	}
	if size > maxDocument {
		return nil, fmt.Errorf("the data document would be %.1f MiB, over the %d MiB cap", float64(size)/(1<<20), maxDocument>>20)
	}
	b := make([]byte, 0, size)
	b = append(b, `{"input":`...)
	b = append(b, input...)
	b = append(b, `,"nodes":{`...)
	for i, p := range parts {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, '"')
		b = append(b, p.id...)
		b = append(b, `":`...)
		b = append(b, p.entry...)
	}
	return append(b, "}}"...), nil
}

// exec runs node i on its own goroutine and reports back whatever happens,
// a panic included.
func (r *run) exec(i int, parts []docPart) {
	var o outcome
	defer func() {
		if v := recover(); v != nil {
			o.entry, o.taken, o.err = nil, nil, &PanicError{Value: v, Stack: debug.Stack()}
		}
		r.msgs <- message{node: i, out: o}
	}()

	n := &r.p.nodes[i]
	doc, err := document(r.input, parts)
	if err != nil {
		o.err = err
		return
	}
	switch n.kind {
	case workflow.NodeKindHTTP:
		o = r.call(i, doc)
	case workflow.NodeKindTransform:
		o = r.transform(n, doc)
	}
	if o.err != nil {
		return
	}
	// Edge conditions see the node's own result too. Evaluating them here
	// keeps a slow condition off the scheduler.
	self := append(parts[:len(parts):len(parts)], docPart{id: n.id, entry: o.entry})
	if doc, err = document(r.input, self); err == nil {
		o.taken, err = r.conditions(n, doc, outputOf(o.result.HTTPStatus))
	}
	o.err = err
}

func (r *run) call(i int, doc []byte) outcome {
	n := &r.p.nodes[i]
	var o outcome
	req, errs := n.request(r.ctx, doc, r.id+":"+n.id)
	if len(errs) > 0 {
		o.err = fmt.Errorf("%s: %w", errs[0].part, errs[0].err)
		return o
	}

	o.result.Request = req
	o.result.Attempts = 1
	res, err := r.e.client.Do(r.ctx, &upstream.Request{
		Method: req.Method, URL: req.URL, Header: req.Header, Body: req.Body,
		Timeout: n.timeout, Attempts: n.attempts, Idempotent: n.idempotent,
		OnRetry: func(attempt int) {
			o.result.Attempts = attempt
			r.msgs <- message{node: i, retry: attempt}
		},
	})
	if res != nil {
		o.result.HTTPStatus, o.result.Header, o.result.Body = res.Status, res.Header, res.Body
	}
	if err != nil && !n.answers(err) {
		o.err = err
		return o
	}
	if o.entry, err = httpEntry(res); err != nil {
		o.err = fmt.Errorf("response: %w", err)
	}
	return o
}

// answers says whether a failed call is an answer after all: a status the
// node lists as one of its outputs.
func (n *node) answers(err error) bool {
	var ue *upstream.Error
	return errors.As(err, &ue) && ue.Kind == upstream.KindStatus && slices.Contains(n.outputs, ue.Status)
}

// outputOf is the output an answer with this status comes out of: the
// status itself, or 0 for 2xx, and for a transform's one output.
func outputOf(status int) int {
	if status >= 200 && status <= 299 {
		return 0
	}
	return status
}

// partError is a part of a request that didn't render: which part, as a
// run's error names it, where it sits below its node in the definition, and
// why.
type partError struct {
	part    string // "url", "query q", "header X" or "body"
	pointer string // "/request/url", "/request/query/q", …
	err     error
}

// request renders node n's request over doc, as a run sends it. Every part
// is rendered and each one that fails is reported, so a preview can show
// them all, where a run stops at the first. key is the Idempotency-Key a
// retried POST or PATCH carries. A part that didn't compile, which only a
// preview's program can hold, is left out: its problem says why.
func (n *node) request(ctx context.Context, doc []byte, key string) (*SentRequest, []partError) {
	req := &SentRequest{Method: n.method, Header: make(http.Header, len(n.headers)+1)}
	var errs []partError
	fail := func(part, pointer string, err error) {
		errs = append(errs, partError{part: part, pointer: pointer, err: err})
	}

	urlOK := false
	if n.url != nil {
		u, err := n.url.Render(ctx, doc, escapeURLValue)
		if err != nil {
			fail("url", "/request/url", err)
		} else {
			req.URL, urlOK = u, true
		}
	}
	if len(n.query) > 0 {
		q := url.Values{}
		for _, p := range n.query {
			if p.value == nil {
				continue
			}
			v, err := p.value.Render(ctx, doc, nil)
			if err != nil {
				fail("query "+p.name, "/request/query/"+workflow.PointerToken(p.name), err)
				continue
			}
			q.Set(p.name, v)
		}
		if urlOK && len(q) > 0 {
			sep := "?"
			if strings.Contains(req.URL, "?") {
				sep = "&"
			}
			req.URL += sep + q.Encode()
		}
	}
	for _, p := range n.headers {
		if p.value == nil {
			continue
		}
		v, err := p.value.Render(ctx, doc, nil)
		if err != nil {
			fail("header "+p.name, "/request/headers/"+workflow.PointerToken(p.name), err)
			continue
		}
		req.Header.Set(p.name, v)
	}
	if n.body != nil {
		body, err := n.body.Eval(ctx, doc)
		if err != nil {
			fail("body", "/request/body", err)
		} else {
			req.Body = body
		}
	}
	// One key for every attempt, so the upstream can recognise a repeat.
	if n.attempts > 1 && n.idempotent && (n.method == http.MethodPost || n.method == http.MethodPatch) &&
		req.Header.Get("Idempotency-Key") == "" {
		req.Header.Set("Idempotency-Key", key)
	}
	return req, errs
}

// escapeURLValue escapes a placeholder's value for where it lands in a URL,
// so the value stays data: one path segment, or one query value.
//
// A path value must also be one segment after any server decodes it. "", "."
// and ".." aren't, and escaping doesn't touch them. A slash isn't either:
// nginx proxying to a URI decodes %2F and then resolves "..", so
// "..%2Fadmin" reached a backend as /admin (measured in plan 02). Backslash
// is a separator to some servers too.
func escapeURLValue(prefix, v string) (string, error) {
	if strings.Contains(prefix, "?") {
		return url.QueryEscape(v), nil
	}
	if v == "" || v == "." || v == ".." || strings.ContainsAny(v, `/\`) {
		return "", fmt.Errorf("the path value %q isn't one segment: it's empty, a dot segment, or holds a slash", v)
	}
	// Everything but unreserved characters is escaped, so nothing in the
	// value can act as a delimiter, whichever ones the upstream uses.
	return strings.ReplaceAll(url.QueryEscape(v), "+", "%20"), nil
}

// httpEntry is an http node's part of the data document. Header names are
// lower case, as HTTP/2 sends them, and repeated fields are joined by commas.
func httpEntry(res *upstream.Response) (json.RawMessage, error) {
	headers := make(map[string]string, len(res.Header))
	for k, v := range res.Header {
		headers[strings.ToLower(k)] = strings.Join(v, ", ")
	}
	return json.Marshal(struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Body    json.RawMessage   `json:"body"` // nil marshals as null
	}{res.Status, headers, res.Body})
}

func (r *run) transform(n *node, doc []byte) outcome {
	v, err := n.expr.Eval(r.ctx, doc)
	if err != nil {
		return outcome{err: fmt.Errorf("expr: %w", err)}
	}
	return outcome{result: NodeResult{Body: v}, entry: bodyEntry(v)}
}

// bodyEntry is a transform node's part of the data document: its value, as
// its body.
func bodyEntry(v json.RawMessage) json.RawMessage {
	return append(append([]byte(`{"body":`), v...), '}')
}

// conditions decides which of n's edges are taken, now that it answered
// through output on: of the edges from that output, those whose condition
// holds over doc.
func (r *run) conditions(n *node, doc []byte, on int) ([]bool, error) {
	taken := make([]bool, len(n.out))
	for j, k := range n.out {
		e := r.p.edges[k]
		switch {
		case e.on != on:
		case e.when == nil:
			taken[j] = true
		default:
			ok, err := e.when.Eval(r.ctx, doc)
			if err != nil {
				return nil, fmt.Errorf("edge to %s: when: %w", r.p.nodes[e.to].id, err)
			}
			taken[j] = ok
		}
	}
	return taken, nil
}
