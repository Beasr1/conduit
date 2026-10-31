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
}

// Engine runs programs. It's safe for concurrent use.
type Engine struct {
	client      *upstream.Client
	concurrency int
	runTimeout  time.Duration
}

// New returns an Engine that calls upstreams through client.
func New(client *upstream.Client, o Options) *Engine {
	return &Engine{
		client:      client,
		concurrency: cmp.Or(o.Concurrency, 8),
		runTimeout:  cmp.Or(o.RunTimeout, 5*time.Minute),
	}
}

// Status is how a node or a run ended.
type Status string

const (
	StatusSucceeded Status = "succeeded"
	StatusFailed    Status = "failed"
	StatusSkipped   Status = "skipped"   // nodes only: no edge into it was taken
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
	Err    error        // why the run didn't succeed: a *NodeError when a node failed it
	Nodes  []NodeResult // one per node, in declaration order
}

// NodeResult is how one node ended.
type NodeResult struct {
	ID       string
	Status   Status
	Attempts int // http nodes: requests sent
	// What an http node got back, even when it failed on the status.
	HTTPStatus int
	Header     http.Header
	// The response body, or a transform node's value.
	Body json.RawMessage
	Err  error
	// Request is what an http node sent, as built, once its URL, headers and
	// body rendered. Nothing is redacted here; whoever stores it does that.
	Request *SentRequest
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
	msgs     chan message
	inFlight int
	firstErr error // the failure that stopped the run
}

type nodeState struct {
	ready, started bool
	ended          bool
	parentsDone    int // edges in whose source has ended
	taken          int // edges in that were taken
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
	// caller: a node is skipped only when its parents all ended without
	// taking an edge to it, and then it has already ended.
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
		res.Answer, res.Output, res.Err = r.answer()
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

// finish records a node's outcome and works out what it unblocks.
func (r *run) finish(i int, o outcome) {
	stopped := r.ctx.Err() != nil
	switch {
	case o.err == nil:
		r.nodes[i].entry = o.entry
		r.end(i, StatusSucceeded, &o)
		for j, k := range r.p.nodes[i].out {
			r.parentEnded(r.p.edges[k].to, o.taken[j])
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

// parentEnded counts an edge into node i whose source has ended. Once all
// have, i is ready if any was taken, and skipped if none was; a skip ends
// i's own edges untaken, so skips cascade.
func (r *run) parentEnded(i int, taken bool) {
	n := &r.nodes[i]
	n.parentsDone++
	if taken {
		n.taken++
	}
	if n.parentsDone < len(r.p.nodes[i].in) {
		return
	}
	if n.taken > 0 {
		n.ready = true
		return
	}
	r.end(i, StatusSkipped, nil)
	for _, k := range r.p.nodes[i].out {
		r.parentEnded(r.p.edges[k].to, false)
	}
}

func (r *run) end(i int, s Status, o *outcome) {
	n := &r.nodes[i]
	n.ended = true
	if o != nil {
		id := n.result.ID
		n.result = o.result
		n.result.ID = id
		n.result.Err = o.err
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

// answer is what the run answers: the answer whose line it took, or the
// output of a definition saved with one, as a 200. A run takes an answer's
// line when its node answered through its output. Taking none, or lines
// from two outputs, fails the run, and so does a node joined to several
// answers that picked none of them.
func (r *run) answer() (int, json.RawMessage, error) {
	if r.p.output != nil {
		out, err := r.output()
		if err != nil {
			return 0, nil, err
		}
		return http.StatusOK, out, nil
	}
	resp := r.p.response
	if resp == nil {
		return 0, nil, nil
	}
	// The answers taken, by the output they're joined to.
	type joined struct {
		from, on int
		statuses []int
	}
	var taken []joined
	for _, a := range resp.answers {
		n := r.nodes[a.from].result
		if n.Status != StatusSucceeded || outputOf(n.HTTPStatus) != a.on {
			continue
		}
		i := slices.IndexFunc(taken, func(j joined) bool { return j.from == a.from && j.on == a.on })
		if i < 0 {
			taken = append(taken, joined{from: a.from, on: a.on})
			i = len(taken) - 1
		}
		taken[i].statuses = append(taken[i].statuses, a.status)
	}
	switch len(taken) {
	case 0:
		return 0, nil, errors.New("no answer: no line into the response was taken")
	case 1:
	default:
		a, b := taken[0], taken[1]
		return 0, nil, fmt.Errorf("two answers: %d from %s and %d from %s were both reached",
			a.statuses[0], r.p.nodes[a.from].id, b.statuses[0], r.p.nodes[b.from].id)
	}
	j := taken[0]
	n := r.nodes[j.from].result
	if len(j.statuses) == 1 && r.p.nodes[j.from].otherwise == nil {
		return j.statuses[0], n.Body, nil
	}
	return pick(n.ID, n.Body, j.statuses)
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

// Unhandled is what the response's unhandled answers a run that gave no
// answer: its body, JSONata evaluated over the run as it stood, its input
// and every node that succeeded, with failure, the run's {code, detail,
// node}, as error. ok says whether the response has one.
func (p *Program) Unhandled(ctx context.Context, input json.RawMessage, nodes []NodeResult, failure json.RawMessage) (body json.RawMessage, ok bool, err error) {
	if p.response == nil || p.response.unhandled == nil {
		return nil, false, nil
	}
	defer func() {
		if v := recover(); v != nil {
			body, err = nil, &PanicError{Value: v, Stack: debug.Stack()}
		}
	}()
	var parts []docPart
	for i, n := range nodes {
		if n.Status != StatusSucceeded || i >= len(p.nodes) {
			continue
		}
		entry := bodyEntry(n.Body)
		if p.nodes[i].kind == workflow.NodeKindHTTP {
			if entry, err = responseEntry(n.HTTPStatus, n.Header, n.Body); err != nil {
				return nil, true, fmt.Errorf("unhandled: %w", err)
			}
		}
		parts = append(parts, docPart{id: p.nodes[i].id, entry: entry})
	}
	if len(input) == 0 {
		input = json.RawMessage("null")
	}
	doc, err := document(input, parts)
	if err != nil {
		return nil, true, fmt.Errorf("unhandled: %w", err)
	}
	doc = append(append(append(doc[:len(doc)-1], `,"error":`...), failure...), '}')
	if body, err = p.response.unhandled.Eval(ctx, doc); err != nil {
		return nil, true, fmt.Errorf("unhandled: %w", err)
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
