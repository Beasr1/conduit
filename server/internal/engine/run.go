package engine

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"net/http"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/Beasr1/conduit/server/internal/upstream"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// Options tune an Engine. Zero values mean the defaults.
type Options struct {
	Concurrency int           // nodes in flight per run; default 8
	RunTimeout  time.Duration // default 5 minutes
	// Workflows runs the workflows nodes use (plan 07); nil, and a node that
	// uses one fails.
	Workflows Caller
}

// Caller runs a workflow a node uses, at the revision it pins, as a run of
// its own in the caller's trace one hop further, and gives its answer
// (plan 07). A run that gives no answer is an error, a *CallError, beside
// what it answered with, if anything. The runner is one.
type Caller interface {
	Call(ctx context.Context, c Call, input json.RawMessage) (Answer, error)
}

// Call is a node running the workflow it uses: which, at which revision,
// and the run and node it's called from.
type Call struct {
	Workflow string
	Revision int
	Run      string
	Node     string
}

// Answer is what a workflow a node uses answered: its status, headers and
// body, as /serve would send them.
type Answer struct {
	Status int
	Header http.Header
	Body   json.RawMessage
}

// Engine runs programs. It's safe for concurrent use.
type Engine struct {
	client      *upstream.Client
	workflows   Caller
	concurrency int
	runTimeout  time.Duration
}

// New returns an Engine that calls upstreams through client.
func New(client *upstream.Client, o Options) *Engine {
	return &Engine{
		client:      client,
		workflows:   o.Workflows,
		concurrency: cmp.Or(o.Concurrency, 8),
		runTimeout:  cmp.Or(o.RunTimeout, 5*time.Minute),
	}
}

// Status is how a node or a run ended.
type Status string

const (
	StatusSucceeded Status = "succeeded"
	StatusFailed    Status = "failed"
	StatusSkipped   Status = "skipped"   // nodes only: an edge into it went untaken, or, into a transform, every one did
	StatusCancelled Status = "cancelled" // stopped by a failure elsewhere, or by the caller
)

// Result is a finished run.
type Result struct {
	Status Status // succeeded, failed or cancelled
	// What the run answers, after success: a status, and a body unless it
	// has none. A definition with neither a response nor an output answers
	// 0, nothing.
	Answer int
	Output json.RawMessage
	// ErrorFrom names the node whose error the answer passes on: its line
	// leaves an http node's block for a status of 400 or more, or a node's
	// Unhandled block with no body of its own. Output is nil then: the
	// response's error body says it, over that error, and the runner, which
	// words failures, evaluates it (plan 12).
	ErrorFrom string
	Err       error        // why the run didn't succeed: a *NodeError when a node failed it
	Nodes     []NodeResult // one per node, in declaration order
}

// NodeResult is how one node ended.
type NodeResult struct {
	ID       string
	Status   Status
	Attempts int // http nodes: requests sent
	// What an http node got back, even when it failed on the status, or the
	// status a transform's case gave, which names the exit it took.
	HTTPStatus int
	Header     http.Header
	// The response body, or a transform node's value.
	Body json.RawMessage
	Err  error
	// Caught says a failed node's Unhandled block took Err, so the run went
	// on down the lines from that block. Gave is what the block's body gave
	// then, if it has one.
	Caught bool
	Gave   json.RawMessage
	// Request is what an http node sent, as built, once its URL, headers and
	// body rendered. Nothing is redacted here; whoever stores it does that.
	Request *SentRequest
	// Took is the edges the node's answer took, in the definition's order:
	// of those leaving the output it answered through, the ones whose
	// condition held.
	Took []Line
}

// Line is an edge a node's answer took: the node it leads to, and the
// output it leaves, a status, 0 for 2xx and the one output of a transform,
// or workflow.OnUnhandled.
type Line struct {
	To string
	On int
}

// SentRequest is a request as an http node built it.
type SentRequest struct {
	Method string
	URL    string
	Header http.Header
	Body   json.RawMessage
}

// EventKind is what happened to a node.
type EventKind string

const (
	EventStarted   EventKind = "started"
	EventRetrying  EventKind = "retrying"
	EventSucceeded EventKind = "succeeded"
	EventFailed    EventKind = "failed"
	EventSkipped   EventKind = "skipped"
	EventCancelled EventKind = "cancelled"
)

// Event is one step in a run's progress.
type Event struct {
	Run     string
	Node    string
	Kind    EventKind
	Attempt int // the attempt starting, or the attempts made when the node ended
	At      time.Time
	// Result is the node's result, on the events that end it: succeeded,
	// failed, skipped and cancelled. So a caller can record and stream each
	// node as it ends, without waiting for the run.
	Result *NodeResult
}

// PanicError is a node or the output panicking: a bug in the engine or in
// the evaluator. Stack is for the log.
type PanicError struct {
	Value any
	Stack []byte
}

func (e *PanicError) Error() string { return fmt.Sprintf("panic: %v", e.Value) }

// NodeError is a node's failure failing the run.
type NodeError struct {
	Node string
	Err  error
}

func (e *NodeError) Error() string { return "node " + e.Node + ": " + e.Err.Error() }

func (e *NodeError) Unwrap() error { return e.Err }

var (
	errFailFast = errors.New("another node failed")
	// ErrRunTimeout is a run stopped by its deadline. Nodes it cut off are
	// failed, not cancelled: they're why the run failed.
	ErrRunTimeout = errors.New("the run ran out of time")
)

// Run executes p with input, raw JSON, and returns when every node has
// ended. The calling goroutine is the run's scheduler. onEvent, if not nil,
// is called from it, one event at a time and in order; scheduling waits for
// it, so it should return quickly.
func (e *Engine) Run(ctx context.Context, p *Program, runID string, input json.RawMessage, onEvent func(Event)) (*Result, error) {
	if len(input) == 0 {
		input = json.RawMessage("null")
	}
	if !json.Valid(input) {
		return nil, errors.New("run input isn't valid JSON")
	}
	ctx, stop := context.WithCancelCause(ctx)
	defer stop(nil)
	ctx, cancel := context.WithTimeoutCause(ctx, e.runTimeout, ErrRunTimeout)
	defer cancel()

	r := &run{
		e: e, p: p, id: runID, input: input, onEvent: onEvent,
		ctx: ctx, stop: stop,
		nodes: make([]nodeState, len(p.nodes)),
		taken: make([]bool, len(p.edges)),
		msgs:  make(chan message, len(p.nodes)),
	}
	return r.schedule(), nil
}

type run struct {
	e       *Engine
	p       *Program
	id      string
	input   json.RawMessage
	onEvent func(Event)

	ctx  context.Context
	stop context.CancelCauseFunc

	nodes    []nodeState
	taken    []bool // by edge, once its source has ended
	msgs     chan message
	inFlight int
	firstErr error // the failure that stopped the run
}

type nodeState struct {
	ready, started bool
	ended          bool
	parentsDone    int // edges in whose source has ended
	entry          json.RawMessage
	result         NodeResult
}

// message is a node goroutine reporting: a retry starting, or the end.
type message struct {
	node  int
	retry int // > 0: this attempt is starting, and nothing else is set
	out   outcome
}

// outcome is what a node goroutine did.
type outcome struct {
	result NodeResult
	entry  json.RawMessage // its part of the data document, on success
	taken  []bool          // per edge out, whether it's taken
	err    error
}

func (r *run) schedule() *Result {
	for i, n := range r.p.nodes {
		r.nodes[i].result.ID = n.id
		r.nodes[i].ready = len(n.in) == 0
	}
	for {
		r.startReady()
		if r.inFlight == 0 {
			break
		}
		m := <-r.msgs
		if m.retry > 0 {
			r.emit(m.node, EventRetrying, m.retry, nil)
			continue
		}
		r.inFlight--
		r.finish(m.node, m.out)
	}

	// Whatever never started was stopped by a failure, the deadline or the
	// caller: a node is skipped only once its parents have all ended, and
	// then it has already ended.
	for i := range r.nodes {
		if !r.nodes[i].ended {
			r.end(i, StatusCancelled, nil)
		}
	}

	res := &Result{Nodes: make([]NodeResult, len(r.nodes))}
	for i := range r.nodes {
		res.Nodes[i] = r.nodes[i].result
	}
	switch cause := context.Cause(r.ctx); {
	case r.firstErr != nil:
		res.Status, res.Err = StatusFailed, r.firstErr
	case errors.Is(cause, ErrRunTimeout):
		res.Status, res.Err = StatusFailed, fmt.Errorf("%w (%v)", ErrRunTimeout, r.e.runTimeout)
	case cause != nil:
		res.Status, res.Err = StatusCancelled, cause
	default:
		res.Answer, res.Output, res.ErrorFrom, res.Err = r.answer()
		res.Status = StatusSucceeded
		if res.Err != nil {
			res.Status = StatusFailed
		}
	}
	return res
}

// startReady starts ready nodes in declaration order, up to the limit.
func (r *run) startReady() {
	for i := range r.nodes {
		if r.inFlight >= r.e.concurrency || r.ctx.Err() != nil {
			return
		}
		n := &r.nodes[i]
		if !n.ready || n.started {
			continue
		}
		n.started = true
		r.inFlight++
		r.emit(i, EventStarted, 1, nil)
		go r.exec(i, r.parts(i))
	}
}

// parts is what node i's expressions may see: the finished ancestors.
func (r *run) parts(i int) []docPart {
	var out []docPart
	for _, a := range r.p.nodes[i].ancestors {
		if e := r.nodes[a].entry; e != nil {
			out = append(out, docPart{id: r.p.nodes[a].id, entry: e})
		}
	}
	return out
}

// finish records a node's outcome and works out what it unblocks. A node
// whose Unhandled block took its failure ends failed, and unblocks as one
// that succeeded does.
func (r *run) finish(i int, o outcome) {
	stopped := r.ctx.Err() != nil
	switch {
	case o.err == nil:
		r.nodes[i].entry = o.entry
		status := StatusSucceeded
		if o.result.Caught {
			status = StatusFailed
		}
		r.end(i, status, &o)
		for j, k := range r.p.nodes[i].out {
			r.lineEnded(k, o.taken[j])
		}
	case !stopped:
		r.firstErr = &NodeError{Node: r.p.nodes[i].id, Err: o.err}
		r.end(i, StatusFailed, &o)
		r.stop(errFailFast)
	case errors.Is(context.Cause(r.ctx), ErrRunTimeout):
		r.end(i, StatusFailed, &o)
	default:
		r.end(i, StatusCancelled, &o)
	}
}

// lineEnded counts edge k, now that its source has ended, taking it or not.
// Once every edge into its node has, the node is ready if it joined, and
// skipped if not; a skip ends the node's own edges untaken, so skips
// cascade.
func (r *run) lineEnded(k int, taken bool) {
	r.taken[k] = taken
	i := r.p.edges[k].to
	n := &r.nodes[i]
	n.parentsDone++
	if n.parentsDone < len(r.p.nodes[i].in) {
		return
	}
	if r.joined(i) {
		n.ready = true
		return
	}
	r.end(i, StatusSkipped, nil)
	for _, k := range r.p.nodes[i].out {
		r.lineEnded(k, false)
	}
}

// joined says whether node i runs, now that every edge into it has ended.
func (r *run) joined(i int) bool {
	return r.p.joins(i, func(k int) bool { return r.taken[k] })
}

// joins says whether node i runs, by which of the edges into it are taken:
// an http node when every one is (plan 04, strict joins), and a transform
// when every required one is and, with none required, any is, or when it
// has none (plan 04, a transform's lines as its parameters).
func (p *Program) joins(i int, taken func(k int) bool) bool {
	in := p.nodes[i].in
	if p.nodes[i].kind != workflow.NodeKindTransform {
		return !slices.ContainsFunc(in, func(k int) bool { return !taken(k) })
	}
	required := func(k int) bool { return p.edges[k].required }
	if slices.ContainsFunc(in, required) {
		return !slices.ContainsFunc(in, func(k int) bool { return required(k) && !taken(k) })
	}
	return len(in) == 0 || slices.ContainsFunc(in, taken)
}

func (r *run) end(i int, s Status, o *outcome) {
	n := &r.nodes[i]
	n.ended = true
	if o != nil {
		id := n.result.ID
		n.result = o.result
		n.result.ID = id
		if o.err != nil {
			n.result.Err = o.err
		}
	}
	n.result.Status = s
	res := n.result
	r.emit(i, EventKind(s), n.result.Attempts, &res)
}

func (r *run) emit(i int, kind EventKind, attempt int, result *NodeResult) {
	if r.onEvent != nil {
		r.onEvent(Event{Run: r.id, Node: r.p.nodes[i].id, Kind: kind, Attempt: attempt, At: time.Now(), Result: result})
	}
}

// answer is what the run answers: the first answer, top to bottom, that one
// of its lines reached (plan 14), with its first line reached; or the
// output of a definition saved with one, as a 200. A run reaches a line
// when its node answered through its output, or failed into its Unhandled
// block for a line from that. A transform with an expr joined to several
// answers picks among them, so its line reaches only the one it picked, and
// picking none of them fails the run, as does reaching no answer. An answer
// that passes an error on names the node it's from, and has no body here
// (Result.ErrorFrom).
func (r *run) answer() (status int, body json.RawMessage, errorFrom string, err error) {
	if r.p.output != nil {
		out, err := r.output()
		if err != nil {
			return 0, nil, "", err
		}
		return http.StatusOK, out, "", nil
	}
	resp := r.p.response
	if resp == nil {
		return 0, nil, "", nil
	}
	for _, a := range resp.answers {
		for _, l := range a.lines {
			if on, ok := took(r.p.nodes[l.from].kind, r.nodes[l.from].result); !ok || on != l.on {
				continue
			}
			n := r.nodes[l.from].result
			switch statuses := resp.picks[l.from]; {
			case l.on == workflow.OnUnhandled && n.Gave != nil:
				return a.status, n.Gave, "", nil
			case l.on == workflow.OnUnhandled, r.p.nodes[l.from].kind == workflow.NodeKindHTTP && l.on >= 400:
				return a.status, nil, n.ID, nil
			case len(statuses) < 2:
				return a.status, n.Body, "", nil
			default:
				picked, body, err := pick(n.ID, n.Body, statuses)
				if err != nil {
					return 0, nil, "", err
				}
				if picked == a.status {
					return a.status, body, "", nil
				}
			}
		}
	}
	return 0, nil, "", errors.New("no answer: no line into the response was taken")
}

// caughtBody is the body a node gives through its Unhandled block: what
// the block's body gave, else what it got.
func (n NodeResult) caughtBody() json.RawMessage {
	if n.Gave != nil {
		return n.Gave
	}
	return n.Body
}

// took is the output node result n, of kind, answered through, and whether
// it answered at all: its Unhandled block, when that took its failure.
func took(kind workflow.NodeKind, n NodeResult) (int, bool) {
	switch {
	case n.Caught:
		return workflow.OnUnhandled, true
	case n.Status == StatusSucceeded:
		return exitOf(kind, n.HTTPStatus), true
	}
	return 0, false
}

// pick reads the answer node id picked among statuses: its result v is
// {"status": …, "body": …}, the status one of them. A body left out is none.
func pick(id string, v json.RawMessage, statuses []int) (int, json.RawMessage, error) {
	var picked map[string]json.RawMessage
	if json.Unmarshal(v, &picked) != nil || picked == nil {
		return 0, nil, fmt.Errorf("not an answer: %s gave no {status, body} object", id)
	}
	for _, k := range slices.Sorted(maps.Keys(picked)) {
		if k != "status" && k != "body" {
			return 0, nil, fmt.Errorf("not an answer: %s gave %q, besides status and body", id, k)
		}
	}
	// A whole number, however the JSON writes it: 404, 404.0 or 4.04e2.
	var status *float64
	if json.Unmarshal(picked["status"], &status) != nil || status == nil || *status != math.Trunc(*status) {
		return 0, nil, fmt.Errorf("not an answer: %s gave no whole number as its status", id)
	}
	if !slices.Contains(statuses, int(*status)) {
		return 0, nil, fmt.Errorf("not an answer: %s gave the status %s, and it's joined to %s", id, picked["status"], statusList(statuses))
	}
	return int(*status), picked["body"], nil
}

// statusList is statuses in words: "200", "200 or 404", "200, 404 or 409".
func statusList(statuses []int) string {
	words := make([]string, len(statuses))
	for i, s := range statuses {
		words[i] = strconv.Itoa(s)
	}
	if len(words) < 2 {
		return strings.Join(words, "")
	}
	return strings.Join(words[:len(words)-1], ", ") + " or " + words[len(words)-1]
}

// ErrorOf is the error an answer passes on (Result.ErrorFrom), as the error
// body reads it: {code, detail, node}, beside the status, headers and body
// the node got back, when it got any. code and detail are the caller's
// words for it.
func ErrorOf(n NodeResult, code, detail string) (json.RawMessage, error) {
	if n.HTTPStatus == 0 {
		return json.Marshal(struct {
			Code   string `json:"code"`
			Detail string `json:"detail"`
			Node   string `json:"node"`
		}{code, detail, n.ID})
	}
	return json.Marshal(struct {
		Code    string            `json:"code"`
		Detail  string            `json:"detail"`
		Node    string            `json:"node"`
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Body    json.RawMessage   `json:"body"` // nil marshals as null
	}{code, detail, n.ID, n.HTTPStatus, lowerHeaders(n.Header), n.Body})
}

// ErrorBody is the response's error body, JSONata evaluated over the run as
// it stood, its input and every node that succeeded or failed into its
// Unhandled block, with failure as error: {code, detail, node}, and the
// upstream's status, headers and body when it answered. It answers a run
// that gave no answer, and an answer that passes an error on. ok says
// whether the response has one.
func (p *Program) ErrorBody(ctx context.Context, input json.RawMessage, nodes []NodeResult, failure json.RawMessage) (body json.RawMessage, ok bool, err error) {
	if p.response == nil || p.response.errors == nil {
		return nil, false, nil
	}
	defer func() {
		if v := recover(); v != nil {
			body, err = nil, &PanicError{Value: v, Stack: debug.Stack()}
		}
	}()
	var parts []docPart
	for i, n := range nodes {
		if i >= len(p.nodes) {
			continue
		}
		var entry json.RawMessage
		switch {
		case n.Caught:
			entry, err = caughtEntry(n)
		case n.Status != StatusSucceeded:
			continue
		case p.nodes[i].kind == workflow.NodeKindHTTP:
			entry, err = responseEntry(n.HTTPStatus, n.Header, n.Body)
		default:
			entry = transformEntry(n.HTTPStatus, n.Body)
		}
		if err != nil {
			return nil, true, fmt.Errorf("error body: %w", err)
		}
		parts = append(parts, docPart{id: p.nodes[i].id, entry: entry})
	}
	if len(input) == 0 {
		input = json.RawMessage("null")
	}
	doc, err := document(input, parts)
	if err != nil {
		return nil, true, fmt.Errorf("error body: %w", err)
	}
	doc = append(append(append(doc[:len(doc)-1], `,"error":`...), failure...), '}')
	if body, err = p.response.errors.Eval(ctx, doc); err != nil {
		return nil, true, fmt.Errorf("error body: %w", err)
	}
	return body, true, nil
}

// output evaluates the output expression over every node that succeeded.
func (r *run) output() (out json.RawMessage, err error) {
	defer func() {
		if v := recover(); v != nil {
			out, err = nil, &PanicError{Value: v, Stack: debug.Stack()}
		}
	}()
	var parts []docPart
	for i, n := range r.nodes {
		if n.entry != nil {
			parts = append(parts, docPart{id: r.p.nodes[i].id, entry: n.entry})
		}
	}
	doc, err := document(r.input, parts)
	if err != nil {
		return nil, fmt.Errorf("output: %w", err)
	}
	out, err = r.p.output.Eval(r.ctx, doc)
	if err != nil {
		return nil, fmt.Errorf("output: %w", err)
	}
	return out, nil
}
