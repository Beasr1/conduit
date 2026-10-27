package engine

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"runtime/debug"
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
		o.taken, err = r.conditions(n, doc)
	}
	o.err = err
}

func (r *run) call(i int, doc []byte) outcome {
	n := &r.p.nodes[i]
	var o outcome
	fail := func(what string, err error) outcome {
		o.err = fmt.Errorf("%s: %w", what, err)
		return o
	}

	u, err := n.url.Render(r.ctx, doc, escapeURLValue)
	if err != nil {
		return fail("url", err)
	}
	if len(n.query) > 0 {
		q := url.Values{}
		for _, p := range n.query {
			v, err := p.value.Render(r.ctx, doc, nil)
			if err != nil {
				return fail("query "+p.name, err)
			}
			q.Set(p.name, v)
		}
		sep := "?"
		if strings.Contains(u, "?") {
			sep = "&"
		}
		u += sep + q.Encode()
	}
	header := make(http.Header, len(n.headers)+1)
	for _, p := range n.headers {
		v, err := p.value.Render(r.ctx, doc, nil)
		if err != nil {
			return fail("header "+p.name, err)
		}
		header.Set(p.name, v)
	}
	var body []byte
	if n.body != nil {
		if body, err = n.body.Eval(r.ctx, doc); err != nil {
			return fail("body", err)
		}
	}
	// One key for every attempt, so the upstream can recognise a repeat.
	if n.attempts > 1 && n.idempotent && (n.method == http.MethodPost || n.method == http.MethodPatch) &&
		header.Get("Idempotency-Key") == "" {
		header.Set("Idempotency-Key", r.id+":"+n.id)
	}

	o.result.Request = &SentRequest{Method: n.method, URL: u, Header: header, Body: body}
	o.result.Attempts = 1
	res, err := r.e.client.Do(r.ctx, &upstream.Request{
		Method: n.method, URL: u, Header: header, Body: body,
		Timeout: n.timeout, Attempts: n.attempts, Idempotent: n.idempotent,
		OnRetry: func(attempt int) {
			o.result.Attempts = attempt
			r.msgs <- message{node: i, retry: attempt}
		},
	})
	if res != nil {
		o.result.HTTPStatus, o.result.Header, o.result.Body = res.Status, res.Header, res.Body
	}
	if err != nil {
		o.err = err
		return o
	}
	if o.entry, err = httpEntry(res); err != nil {
		return fail("response", err)
	}
	return o
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
	entry := append(append([]byte(`{"body":`), v...), '}')
	return outcome{result: NodeResult{Body: v}, entry: entry}
}

func (r *run) conditions(n *node, doc []byte) ([]bool, error) {
	taken := make([]bool, len(n.out))
	for j, k := range n.out {
		e := r.p.edges[k]
		if e.when == nil {
			taken[j] = true
			continue
		}
		ok, err := e.when.Eval(r.ctx, doc)
		if err != nil {
			return nil, fmt.Errorf("edge to %s: when: %w", r.p.nodes[e.to].id, err)
		}
		taken[j] = ok
	}
	return taken, nil
}
