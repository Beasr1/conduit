package engine

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/Beasr1/conduit/server/internal/upstream"
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
	Status Status          // succeeded, failed or cancelled
	Output json.RawMessage // the output expression's value, after success
	Err    error           // why the run didn't succeed
	Nodes  []NodeResult    // one per node, in declaration order
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
}

// PanicError is a node or the output panicking: a bug in the engine or in
// the evaluator. Stack is for the log.
type PanicError struct {
	Value any
	Stack []byte
}

func (e *PanicError) Error() string { return fmt.Sprintf("panic: %v", e.Value) }

var (
	errFailFast   = errors.New("another node failed")
	errRunTimeout = errors.New("the run ran out of time")
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
	ctx, cancel := context.WithTimeoutCause(ctx, e.runTimeout, errRunTimeout)
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
			r.emit(m.node, EventRetrying, m.retry)
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
	case errors.Is(cause, errRunTimeout):
		res.Status, res.Err = StatusFailed, fmt.Errorf("%w (%v)", errRunTimeout, r.e.runTimeout)
	case cause != nil:
		res.Status, res.Err = StatusCancelled, cause
	default:
		res.Output, res.Err = r.output()
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
		r.emit(i, EventStarted, 1)
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
		r.firstErr = fmt.Errorf("node %s: %w", r.p.nodes[i].id, o.err)
		r.end(i, StatusFailed, &o)
		r.stop(errFailFast)
	case errors.Is(context.Cause(r.ctx), errRunTimeout):
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
	r.emit(i, EventKind(s), n.result.Attempts)
}

func (r *run) emit(i int, kind EventKind, attempt int) {
	if r.onEvent != nil {
		r.onEvent(Event{Run: r.id, Node: r.p.nodes[i].id, Kind: kind, Attempt: attempt, At: time.Now()})
	}
}

// output evaluates the output expression over every node that succeeded.
func (r *run) output() (out json.RawMessage, err error) {
	if r.p.output == nil {
		return nil, nil
	}
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
