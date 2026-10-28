package runner

import (
	"sync"
	"time"

	"github.com/Beasr1/conduit/server/internal/engine"
	"github.com/Beasr1/conduit/server/internal/store"
)

// Event is one entry in a run's event stream. Node events are numbered from
// 1, in order, so a client that reconnects can say what it already has. The
// run's own event is always the last, and has no number: its stream id is
// `end`.
type Event struct {
	Seq  int        // a node event's number; 0 on the run's event
	Node *NodeEvent // a node's progress
	Run  *store.Run // the run as recorded once it ended
}

// NodeEvent is a node starting, retrying or ending.
type NodeEvent struct {
	Node       string
	Kind       engine.EventKind
	Attempt    int // the attempt starting, or the attempts made once it ended
	At         time.Time
	HTTPStatus int      // on the event that ends an http node that got an answer
	Failure    *Failure // on the event that ends a failed node
}

// keep is how long an ended run's events stay in memory, for a client that
// connects late or reconnects.
const keep = time.Minute

// hub holds the event logs of runs in progress and of runs that ended in the
// last minute. A client following a run is a position in its log: it takes
// what's after its position, then waits for the log to grow. No client has a
// buffer of its own, so a slow one is never dropped, and never slows the run.
type hub struct {
	mu   sync.Mutex
	logs map[string]*eventLog
}

// eventLog holds a run's node events. The run's own last event isn't kept:
// it can carry 1 MiB of input and 256 KiB of output, and it's in the
// database.
type eventLog struct {
	events  []Event
	ended   bool
	changed chan struct{} // closed, and replaced, each time the log grows or ends
}

func newHub() *hub { return &hub{logs: make(map[string]*eventLog)} }

func (h *hub) open(runID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.logs[runID] = &eventLog{changed: make(chan struct{})}
}

// publish appends e to the run's log and wakes everyone waiting on it.
func (h *hub) publish(runID string, e NodeEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	l := h.logs[runID]
	l.events = append(l.events, Event{Seq: len(l.events) + 1, Node: &e})
	l.wake()
}

// end marks the run's log ended, once the run is recorded, and wakes
// everyone waiting on it. The log is forgotten a minute later.
func (h *hub) end(runID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.logs[runID].ended = true
	h.logs[runID].wake()
	time.AfterFunc(keep, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		delete(h.logs, runID)
	})
}

func (l *eventLog) wake() {
	close(l.changed)
	l.changed = make(chan struct{})
}

// since returns the run's node events numbered after after, whether the run
// has ended, and a channel that's closed when either changes. ok is false if
// the hub has no log for the run.
func (h *hub) since(runID string, after int) (events []Event, ended bool, changed <-chan struct{}, ok bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	l, ok := h.logs[runID]
	if !ok {
		return nil, false, nil, false
	}
	if n := len(l.events); after < n {
		// Capped, so nothing the caller does with it can reach entries
		// appended later.
		events = l.events[max(after, 0):n:n]
	}
	return events, l.ended, l.changed, true
}
