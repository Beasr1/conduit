// Package runner starts runs and sees them through. It checks a run's
// input, records the run and each node as it ends, streams the run's events
// to watchers, caps how many runs are in progress, and marks failed the runs
// a stopped process never finished.
//
// Editor runs go on in the background after the request that started them;
// served runs keep their caller waiting. Either way the engine's scheduler
// never waits on the database: each run has a writer goroutine that records
// its nodes, with room for every node's result.
package runner

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/Beasr1/conduit/server/internal/engine"
	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/upstream"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// Options tune a Runner. Zero values mean the defaults.
type Options struct {
	MaxRuns       int           // runs in progress at once; default 32
	EditorTimeout time.Duration // default 5 minutes
	ServedTimeout time.Duration // default 30 s, under the server's 35 s WriteTimeout
}

// Runner starts and records runs. It's safe for concurrent use.
type Runner struct {
	store  *store.Store
	editor *engine.Engine
	served *engine.Engine
	log    *slog.Logger
	events *hub
	// slots holds a token for each run in progress: the cap.
	slots chan struct{}
	// stopping is done once Stop is called: editor runs are cancelled, and
	// no run starts.
	stopping context.Context
	stop     context.CancelFunc
}

// New returns a Runner whose runs call upstreams through client.
func New(s *store.Store, client *upstream.Client, log *slog.Logger, o Options) *Runner {
	stopping, stop := context.WithCancel(context.Background())
	return &Runner{
		store:    s,
		editor:   engine.New(client, engine.Options{RunTimeout: cmp.Or(o.EditorTimeout, 5*time.Minute)}),
		served:   engine.New(client, engine.Options{RunTimeout: cmp.Or(o.ServedTimeout, 30*time.Second)}),
		log:      log,
		events:   newHub(),
		slots:    make(chan struct{}, cmp.Or(o.MaxRuns, 32)),
		stopping: stopping,
		stop:     stop,
	}
}

var (
	// ErrBusy is the cap on runs in progress reached, or the server shutting
	// down. Try again shortly.
	ErrBusy = errors.New("too many runs in progress")
	// ErrNotPublished is a served workflow with no published revision.
	ErrNotPublished = errors.New("the workflow has no published revision")
	// ErrNotHere is a run in progress whose events this process doesn't
	// hold: it's only just starting.
	ErrNotHere = errors.New("the run's events aren't available yet")
	// ErrStopped cancels editor runs when the server shuts down.
	ErrStopped = errors.New("the server shut down before the run ended")
	// ErrCallerGone cancels a served run whose caller hung up.
	ErrCallerGone = errors.New("the caller hung up before the run ended")
)

// InvalidError is a revision with problems, which can't run.
type InvalidError struct {
	Revision int
	Problems workflow.Problems
}

func (e *InvalidError) Error() string { return fmt.Sprintf("revision %d has problems", e.Revision) }

// InputError is input the definition's input_schema refuses.
type InputError struct {
	Problems []workflow.Problem // each pointing into the input
}

func (e *InputError) Error() string { return "the input doesn't match the input schema" }

// Outcome is how a run ended.
type Outcome struct {
	Run     store.Run       // as recorded
	Output  json.RawMessage // in full, once it succeeded; null if the definition has no output
	Failure *Failure        // why it didn't
}

// Start runs a revision of a workflow in the background and returns the run
// as recorded: still running. Revision 0 means the latest. The run outlives
// the request that started it; Stop cancels it.
func (r *Runner) Start(ctx context.Context, workflowID string, revision int, input json.RawMessage) (store.Run, error) {
	w, err := r.store.Workflow(ctx, workflowID)
	if err != nil {
		return store.Run{}, err
	}
	if revision == 0 {
		revision = w.LatestRevision
	}
	input = orNull(input)
	p, err := r.prepare(ctx, w.ID, revision, input)
	if err != nil {
		return store.Run{}, err
	}
	run, err := r.begin(ctx, w.ID, revision, "editor", input)
	if err != nil {
		return store.Run{}, err
	}
	// Request values (the log's, say) stay; its cancellation doesn't.
	runCtx, cancel := context.WithCancelCause(context.WithoutCancel(ctx))
	stopped := context.AfterFunc(r.stopping, func() { cancel(ErrStopped) })
	go func() {
		defer cancel(nil)
		defer stopped()
		r.execute(runCtx, r.editor, p, run)
	}()
	return run, nil
}

// Serve runs the published revision of the workflow at slug, and returns
// once the run has ended and been recorded. A caller who hangs up cancels
// the run.
func (r *Runner) Serve(ctx context.Context, slug string, input json.RawMessage) (Outcome, error) {
	w, err := r.store.WorkflowBySlug(ctx, slug)
	if err != nil {
		return Outcome{}, err
	}
	if w.PublishedRevision == nil {
		return Outcome{}, fmt.Errorf("workflow %q: %w", slug, ErrNotPublished)
	}
	input = orNull(input)
	p, err := r.prepare(ctx, w.ID, *w.PublishedRevision, input)
	if err != nil {
		return Outcome{}, err
	}
	run, err := r.begin(ctx, w.ID, *w.PublishedRevision, "served", input)
	if err != nil {
		return Outcome{}, err
	}
	// Cancelled with a cause that says why, rather than context.Canceled.
	runCtx, cancel := context.WithCancelCause(context.WithoutCancel(ctx))
	defer cancel(nil)
	gone := context.AfterFunc(ctx, func() { cancel(ErrCallerGone) })
	defer gone()
	return r.execute(runCtx, r.served, p, run), nil
}

// Recover marks failed every run still recorded as running: at startup,
// before serving, those are runs a stopped process never finished.
func (r *Runner) Recover(ctx context.Context) error {
	n, err := r.store.MarkInterrupted(ctx)
	if err != nil {
		return err
	}
	if n > 0 {
		r.log.WarnContext(ctx, "marked interrupted runs as failed", "runs", n)
	}
	return nil
}

// Stop cancels editor runs, which then record themselves as cancelled, and
// refuses new runs. It doesn't wait for them: Wait does. Served runs aren't
// cancelled; the HTTP server's shutdown waits for their requests.
func (r *Runner) Stop() { r.stop() }

// Wait returns once every run has ended and been recorded, or ctx is done.
// It holds every slot when it returns, so call it only after Stop.
func (r *Runner) Wait(ctx context.Context) error {
	for range cap(r.slots) {
		select {
		case r.slots <- struct{}{}:
		case <-ctx.Done():
			return fmt.Errorf("runs still in progress: %w", ctx.Err())
		}
	}
	return nil
}

// Watch follows a run's events from the node event after number after. It
// fails at once if there's no such run (store.ErrNotFound), or if it's
// running but this process doesn't hold its events (ErrNotHere).
func (r *Runner) Watch(ctx context.Context, runID string, after int) (*Watch, error) {
	if _, _, _, ok := r.events.since(runID, after); !ok {
		if _, err := r.ended(ctx, runID); err != nil {
			return nil, err
		}
	}
	return &Watch{r: r, runID: runID, after: after}, nil
}

// Watch is one client's place in a run's events.
type Watch struct {
	r     *Runner
	runID string
	after int  // the last node event returned
	done  bool // the run's own event has been returned
}

// Next returns the events after those already returned: at once if there
// are any, or else once there are, or when ctx is done. The run's own event
// comes last, and after it Next returns io.EOF.
func (w *Watch) Next(ctx context.Context) ([]Event, error) {
	if w.done {
		return nil, io.EOF
	}
	for {
		events, ended, changed, ok := w.r.events.since(w.runID, w.after)
		if n := len(events); n > 0 {
			w.after = events[n-1].Seq
		}
		if !ok || ended {
			run, err := w.r.ended(ctx, w.runID)
			if err != nil {
				return nil, err
			}
			w.done = true
			return append(events, Event{Run: &run}), nil
		}
		if len(events) > 0 {
			return events, nil
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// ended is how a run ended, from the database: a run is recorded before its
// log hears it ended. A run there that's still running, with no log here,
// belongs to no process this one knows of.
func (r *Runner) ended(ctx context.Context, runID string) (store.Run, error) {
	run, err := r.store.Run(ctx, runID)
	if err != nil {
		return store.Run{}, err
	}
	if run.Status == "running" {
		return store.Run{}, ErrNotHere
	}
	return run, nil
}

// prepare compiles a revision and checks input against its input_schema.
func (r *Runner) prepare(ctx context.Context, workflowID string, revision int, input json.RawMessage) (*engine.Program, error) {
	rev, err := r.store.Revision(ctx, workflowID, revision)
	if err != nil {
		return nil, err
	}
	var d workflow.Definition
	if err := json.Unmarshal(rev.Definition, &d); err != nil {
		return nil, fmt.Errorf("decode revision %d of %s: %w", revision, workflowID, err)
	}
	p, err := engine.Compile(&d)
	var ps workflow.Problems
	if errors.As(err, &ps) {
		return nil, &InvalidError{Revision: revision, Problems: ps}
	}
	if err != nil {
		return nil, err
	}
	if !json.Valid(input) {
		return nil, &InputError{Problems: []workflow.Problem{{Code: "invalid_json", Detail: "the input isn't JSON"}}}
	}
	if ps := p.CheckInput(input); len(ps) > 0 {
		return nil, &InputError{Problems: ps}
	}
	return p, nil
}

// begin takes a slot and records the run as running.
func (r *Runner) begin(ctx context.Context, workflowID string, revision int, trigger string, input json.RawMessage) (store.Run, error) {
	if r.stopping.Err() != nil {
		return store.Run{}, ErrBusy
	}
	select {
	case r.slots <- struct{}{}:
	default:
		return store.Run{}, ErrBusy
	}
	run, err := r.store.StartRun(ctx, workflowID, revision, trigger, input)
	if err != nil {
		<-r.slots
		return store.Run{}, err
	}
	r.events.open(run.ID)
	return run, nil
}

// writeTimeout bounds each write that records a run, including the wait
// for a connection.
const writeTimeout = 10 * time.Second

// execute runs p and records it: each node as it ends, through the writer,
// then the run. It frees the run's slot once the run is recorded.
func (r *Runner) execute(ctx context.Context, e *engine.Engine, p *engine.Program, run store.Run) Outcome {
	defer func() { <-r.slots }()
	// What a cancelled run did is still recorded.
	rec := context.WithoutCancel(ctx)

	ends := make(chan nodeEnd, p.NodeCount()) // one per node, so a send never waits
	written := make(chan struct{})
	go func() {
		defer close(written)
		for n := range ends {
			r.saveNode(rec, run.ID, n)
		}
	}()

	// Only the scheduler goroutine, which calls the callback, touches these.
	started := make(map[string]time.Time)
	failures := make(map[string]*Failure)
	res, err := e.Run(ctx, p, run.ID, run.Input, func(ev engine.Event) {
		ne := NodeEvent{Node: ev.Node, Kind: ev.Kind, Attempt: ev.Attempt, At: ev.At}
		if ev.Kind == engine.EventStarted {
			started[ev.Node] = ev.At
		}
		if nr := ev.Result; nr != nil {
			ne.HTTPStatus = nr.HTTPStatus
			if nr.Status == engine.StatusFailed {
				ne.Failure = r.failure(ctx, run.ID, ev.Node, nr.Err)
				failures[ev.Node] = ne.Failure
			}
			end := nodeEnd{result: *nr, failure: ne.Failure, endedAt: ev.At}
			if t, ok := started[ev.Node]; ok {
				end.startedAt = &t
			}
			ends <- end
		}
		r.events.publish(run.ID, ne)
	})
	close(ends)
	<-written
	if err != nil { // Run refuses only input that isn't JSON, which prepare checked
		res = &engine.Result{Status: engine.StatusFailed, Err: err}
	}

	out := Outcome{Run: run, Output: orNull(res.Output)}
	var output, errDoc json.RawMessage
	var truncated bool
	var ne *engine.NodeError
	switch {
	case res.Status == engine.StatusSucceeded:
		output, truncated = capped(res.Output)
	case res.Status == engine.StatusCancelled:
		out.Failure = &Failure{Code: CodeCancelled, Detail: res.Err.Error()}
	case errors.As(res.Err, &ne) && failures[ne.Node] != nil:
		f := *failures[ne.Node] // already logged, if it's our bug
		f.Node = ne.Node
		out.Failure = &f
	default: // the run's timeout, or the output expression
		out.Failure = r.failure(ctx, run.ID, "", res.Err)
	}
	if out.Failure != nil {
		errDoc, err = json.Marshal(out.Failure)
		if err != nil {
			r.log.ErrorContext(ctx, "encode a run's failure", "run", run.ID, "err", err)
		}
	}

	wctx, cancel := context.WithTimeout(rec, writeTimeout)
	defer cancel()
	final, err := r.store.FinishRun(wctx, run.ID, string(res.Status), output, truncated, errDoc)
	if err != nil {
		// The row stays running until the next start marks it interrupted.
		r.log.ErrorContext(ctx, "record a run's end", "run", run.ID, "err", err)
		now := time.Now()
		final = run
		final.Status, final.Output, final.OutputTruncated, final.Error, final.EndedAt = string(res.Status), output, truncated, errDoc, &now
	}
	out.Run = final
	r.events.end(run.ID)
	return out
}

// failure is err as a Failure. Our bug is logged with its stack, since the
// client only learns that something went wrong. node is empty for the
// output expression.
func (r *Runner) failure(ctx context.Context, runID, node string, err error) *Failure {
	f := &Failure{Code: classify(err), Detail: err.Error()}
	if f.Code == CodeInternal {
		var pe *engine.PanicError
		if errors.As(err, &pe) {
			r.log.ErrorContext(ctx, "a run panicked", "run", runID, "node", node, "panic", pe.Value, "stack", string(pe.Stack))
		}
		f.Detail = internalDetail
	}
	return f
}

// saveNode records a node that ended. A failure is logged: the run goes on.
func (r *Runner) saveNode(ctx context.Context, runID string, n nodeEnd) {
	rec, err := nodeRecord(runID, n)
	if err == nil {
		ctx, cancel := context.WithTimeout(ctx, writeTimeout)
		defer cancel()
		err = r.store.SaveNodeRun(ctx, rec)
	}
	if err != nil {
		r.log.ErrorContext(ctx, "record a node", "run", runID, "node", n.result.ID, "err", err)
	}
}

// orNull is absent JSON as JSON null.
func orNull(doc json.RawMessage) json.RawMessage {
	if len(doc) == 0 {
		return json.RawMessage("null")
	}
	return doc
}
