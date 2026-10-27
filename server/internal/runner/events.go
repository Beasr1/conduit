package runner

import (
	"sync"
	"time"

	"github.com/Beasr1/conduit/server/internal/engine"
	"github.com/Beasr1/conduit/server/internal/store"
)

// Event is one entry in a run's event stream. Seq numbers them from 1, in
// order, so a client that reconnects can say what it already has.
type Event struct {
	Seq  int
	Node *NodeEvent // a node's progress
	Run  *store.Run // the run as recorded once it ended: always the last event
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

const (
	// keep is how long an ended run's events stay in memory, for a client
	// that connects late or reconnects.
	keep = time.Minute
	// watchBuffer is how far a watcher may fall behind before it's dropped.
	// A dropped client reconnects and catches up from the log, so a slow
	// one never slows the run.
	watchBuffer = 64
)

// hub holds the event logs of runs in progress and runs that ended in the
// last minute.
type hub struct {
	mu   sync.Mutex
	logs map[string]*eventLog
}

// eventLog holds a run's node events. The run's own last event isn't kept:
// it can carry 256 KiB of output, and it's in the database.
type eventLog struct {
	events   []Event
	end      int // the run event's Seq once the run has ended, else 0
	watchers map[chan Event]struct{}
}

func newHub() *hub { return &hub{logs: make(map[string]*eventLog)} }

func (h *hub) open(runID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.logs[runID] = &eventLog{watchers: make(map[chan Event]struct{})}
}

// publish appends e to the run's log and sends it to every watcher. A
// watcher whose buffer is full is dropped: its channel is closed.
func (h *hub) publish(runID string, e NodeEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	l := h.logs[runID]
	ev := Event{Seq: len(l.events) + 1, Node: &e}
	l.events = append(l.events, ev)
	for ch := range l.watchers {
		select {
		case ch <- ev:
		default:
			close(ch)
			delete(l.watchers, ch)
		}
	}
}

// end sends the run's last event to every watcher and closes their
// channels. The log is forgotten a minute later.
func (h *hub) end(runID string, final store.Run) {
	h.mu.Lock()
	defer h.mu.Unlock()
	l := h.logs[runID]
	l.end = len(l.events) + 1
	ev := Event{Seq: l.end, Run: &final}
	for ch := range l.watchers {
		select {
		case ch <- ev:
		default: // it fell behind; it reconnects and gets the event from the database
		}
		close(ch)
	}
	l.watchers = nil
	time.AfterFunc(keep, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		delete(h.logs, runID)
	})
}

// watch returns the run's node events numbered after after, and its
// number for the run's last event, or 0 while it runs. While it runs, live
// gets each event from here on; the caller must call unwatch with it. ok is
// false if the hub has no log for the run.
func (h *hub) watch(runID string, after int) (events []Event, end int, live chan Event, ok bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	l, ok := h.logs[runID]
	if !ok {
		return nil, 0, nil, false
	}
	if after < len(l.events) {
		events = append(events, l.events[max(after, 0):]...)
	}
	if l.end == 0 {
		live = make(chan Event, watchBuffer)
		l.watchers[live] = struct{}{}
	}
	return events, l.end, live, true
}

// unwatch stops sending to live, if the hub still is.
func (h *hub) unwatch(runID string, live chan Event) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if l, ok := h.logs[runID]; ok {
		delete(l.watchers, live)
	}
}
