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
// a panic included. parts is what it reads. A failure of the node's own
// goes to its Unhandled block when a line leaves that: the node ends
// failed, giving what the block's body gives, and the run goes on down
// those lines. The run's end, by its deadline or a failure elsewhere, and a
// panic, our bug, never do.
func (r *run) exec(i int, parts []docPart) {
	var o outcome
	defer func() {
		if v := recover(); v != nil {
			o.entry, o.taken, o.err = nil, nil, &PanicError{Value: v, Stack: debug.Stack()}
			o.result.Caught = false
		}
		r.msgs <- message{node: i, out: o}
	}()

	n := &r.p.nodes[i]
	doc, err := document(r.input, parts)
	switch {
	case err != nil:
		o.err = err
	case n.kind == workflow.NodeKindHTTP:
		o = r.call(i, doc)
	case n.kind == workflow.NodeKindTransform:
		o = r.transform(n, doc)
	}
	on := exitOf(n.kind, o.result.HTTPStatus)
	if o.err != nil {
		if !n.catches || r.ctx.Err() != nil {
			return
		}
		o.result.Err, o.result.Caught = o.err, true
		o.entry, o.err = caughtEntry(o.result)
		if o.err == nil && n.unhandled != nil {
			if o.result.Gave, err = r.unhandledGives(n, parts, o.entry); err != nil {
				// Its body failing fails the run, and says what the block took
				// too, as words: the body is the cause.
				o.err = fmt.Errorf("%s; then unhandled: body: %w", o.result.Err.Error(), err)
			} else {
				o.entry, o.err = caughtEntry(o.result)
			}
		}
		if o.err != nil {
			o.result.Err, o.result.Caught = nil, false
			return
		}
		on = workflow.OnUnhandled
	}
	// Edge conditions see the node's own result too. Evaluating them here
	// keeps a slow condition off the scheduler.
	self := append(parts[:len(parts):len(parts)], docPart{id: n.id, entry: o.entry})
	if doc, err = document(r.input, self); err == nil {
		if o.taken, err = r.conditions(n, doc, on); err == nil {
			o.result.Took = r.took(n, o.taken)
		}
	}
	if err != nil && o.result.Caught {
		// A condition on a line from Unhandled that fails fails the run, and
		// says what the block took too, as words: the condition is the cause.
		err = fmt.Errorf("%s; then %w", o.result.Err.Error(), err)
		o.result.Err, o.result.Caught = nil, false
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
// status itself, or 0 for 2xx, and for a transform's one output. A failure
// comes out of workflow.OnUnhandled.
func outputOf(status int) int {
	if status >= 200 && status <= 299 {
		return 0
	}
	return status
}

// exitOf is the output a node of kind answered through, given the status it
// answered with: an http node's, as outputOf has it; a transform's case's
// own, or 0, its one output, for a transform with an expr.
func exitOf(kind workflow.NodeKind, status int) int {
	if kind == workflow.NodeKindTransform {
		return status
	}
	return outputOf(status)
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

// httpEntry is an http node's part of the data document.
func httpEntry(res *upstream.Response) (json.RawMessage, error) {
	return responseEntry(res.Status, res.Header, res.Body)
}

// responseEntry is an http node's part of the data document from what it
// got back: its status, headers and body.
func responseEntry(status int, header http.Header, body json.RawMessage) (json.RawMessage, error) {
	return json.Marshal(struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Body    json.RawMessage   `json:"body"` // nil marshals as null
	}{status, lowerHeaders(header), body})
}

// lowerHeaders is header as the data document has it: names in lower case,
// as HTTP/2 sends them, and repeated fields joined by commas.
func lowerHeaders(header http.Header) map[string]string {
	headers := make(map[string]string, len(header))
	for k, v := range header {
		headers[strings.ToLower(k)] = strings.Join(v, ", ")
	}
	return headers
}

// unhandledGives is what node n's Unhandled body gives over what the node
// read, its own failure, entry, among it.
func (r *run) unhandledGives(n *node, parts []docPart, entry json.RawMessage) (json.RawMessage, error) {
	doc, err := document(r.input, append(parts[:len(parts):len(parts)], docPart{id: n.id, entry: entry}))
	if err != nil {
		return nil, err
	}
	return n.unhandled.Eval(r.ctx, doc)
}

// caughtEntry is the part of the data document of a node whose Unhandled
// block took its failure: the failure as error, {code, detail}, after the
// status, headers and body an http node got back, when it got an answer.
// What the block's body gave, once it has, is the body.
func caughtEntry(res NodeResult) (json.RawMessage, error) {
	return failureEntry(res.HTTPStatus, res.Header, res.caughtBody(), Classify(res.Err), res.Err.Error())
}

// failureEntry is a failed node's part of the data document: its status,
// headers and body when it got an answer, else its body when it has one,
// and the failure as error.
func failureEntry(status int, header http.Header, body json.RawMessage, code, detail string) (json.RawMessage, error) {
	type failure struct {
		Code   string `json:"code"`
		Detail string `json:"detail"`
	}
	f := failure{Code: code, Detail: detail}
	if status == 0 {
		return json.Marshal(struct {
			Body  json.RawMessage `json:"body,omitempty"`
			Error failure         `json:"error"`
		}{body, f})
	}
	return json.Marshal(struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Body    json.RawMessage   `json:"body"` // nil marshals as null
		Error   failure           `json:"error"`
	}{status, lowerHeaders(header), body, f})
}

// transform runs transform node n over doc: its expr's value, or the status
// and body of the case that holds, as an http node's answer.
func (r *run) transform(n *node, doc []byte) outcome {
	status, body, _, err := n.give(r.ctx, doc)
	if err != nil {
		return outcome{err: err}
	}
	return outcome{result: NodeResult{HTTPStatus: status, Body: body}, entry: transformEntry(status, body)}
}

// ErrNoCase is a switch whose cases none hold. It fails the node, as any
// failure of its own does, and its Unhandled block takes that.
var ErrNoCase = errors.New("no case holds")

// give is what transform node n gives over doc: its expr's value, with no
// status; or, from its switch, the status and body of the first case whose
// condition holds, a body left out none, and with none holding, ErrNoCase.
// A failure says, in words and as a pointer below the node, where it is.
func (n *node) give(ctx context.Context, doc []byte) (status int, body json.RawMessage, part string, err error) {
	if n.cases == nil {
		v, err := n.expr.Eval(ctx, doc)
		if err != nil {
			return 0, nil, "/expr", fmt.Errorf("expr: %w", err)
		}
		return 0, v, "", nil
	}
	for k := range n.cases {
		c := &n.cases[k]
		holds, err := c.when.Eval(ctx, doc)
		if err != nil {
			return 0, nil, fmt.Sprintf("/switch/cases/%d/when", k), fmt.Errorf("case %d: when: %w", k+1, err)
		}
		if !holds {
			continue
		}
		if c.body != nil {
			if body, err = c.body.Eval(ctx, doc); err != nil {
				return 0, nil, fmt.Sprintf("/switch/cases/%d/body", k), fmt.Errorf("case %d: body: %w", k+1, err)
			}
		}
		return c.status, body, "", nil
	}
	return 0, nil, "/switch", ErrNoCase
}

// took is the edges n's answer took, taken, as a run records them; nil
// for none.
func (r *run) took(n *node, taken []bool) []Line {
	var out []Line
	for j, k := range n.out {
		if taken[j] {
			e := r.p.edges[k]
			out = append(out, Line{To: r.p.nodes[e.to].id, On: e.on})
		}
	}
	return out
}

// transformEntry is a transform node's part of the data document: the
// status and body of the case that held, as an http node's answer has them,
// a body left out null; or its expr's value, as its body.
func transformEntry(status int, body json.RawMessage) json.RawMessage {
	if status == 0 {
		return bodyEntry(body)
	}
	// A nil json.RawMessage prints as null.
	return fmt.Appendf(nil, `{"status":%d,"body":%s}`, status, body)
}

// bodyEntry is a transform node's part of the data document: its
// value, as its body.
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
