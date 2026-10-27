package runner

import (
	"fmt"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Beasr1/conduit/server/internal/engine"
	"github.com/Beasr1/conduit/server/internal/store"
)

// seqs renders events as "1 a started, 2 run succeeded".
func seqs(events []Event) string {
	var out []string
	for _, e := range events {
		switch {
		case e.Node != nil:
			out = append(out, fmt.Sprintf("%d %s %s", e.Seq, e.Node.Node, e.Node.Kind))
		case e.Run != nil:
			out = append(out, fmt.Sprintf("%d run %s", e.Seq, e.Run.Status))
		}
	}
	return strings.Join(out, ", ")
}

func drain(ch <-chan Event) []Event {
	var out []Event
	for e := range ch {
		out = append(out, e)
	}
	return out
}

func TestHub_ReplaysThenStreams(t *testing.T) {
	t.Parallel()
	h := newHub()
	h.open("r")
	h.publish("r", NodeEvent{Node: "a", Kind: engine.EventStarted})
	h.publish("r", NodeEvent{Node: "a", Kind: engine.EventSucceeded})

	events, end, live, ok := h.watch("r", 1)
	if !ok || end != 0 || live == nil || seqs(events) != "2 a succeeded" {
		t.Fatalf("watch after 1 = %s, end %d, live %v, ok %v", seqs(events), end, live != nil, ok)
	}
	h.publish("r", NodeEvent{Node: "b", Kind: engine.EventStarted})
	h.end("r", store.Run{Status: "succeeded"})
	if got := seqs(drain(live)); got != "3 b started, 4 run succeeded" {
		t.Errorf("live = %s", got)
	}

	// Once it has ended, a watch gets the node events and the run event's
	// number, but no channel: the run event comes from the database.
	events, end, live, ok = h.watch("r", 0)
	if !ok || end != 4 || live != nil || seqs(events) != "1 a started, 2 a succeeded, 3 b started" {
		t.Errorf("watch after the end = %s, end %d, live %v", seqs(events), end, live != nil)
	}
	if _, _, _, ok := h.watch("other", 0); ok {
		t.Error("watch of an unknown run: ok")
	}
}

func TestHub_DropsAWatcherThatFallsBehind(t *testing.T) {
	t.Parallel()
	h := newHub()
	h.open("r")
	_, _, slow, _ := h.watch("r", 0)
	_, _, keeping, _ := h.watch("r", 0)
	for i := range watchBuffer + 1 {
		h.publish("r", NodeEvent{Node: fmt.Sprint(i), Kind: engine.EventStarted})
		<-keeping
	}
	// slow got a full buffer, then its channel was closed: it reconnects
	// and catches up from the log.
	if got := drain(slow); len(got) != watchBuffer || got[len(got)-1].Seq != watchBuffer {
		t.Errorf("slow watcher got %d events before being dropped, want %d", len(got), watchBuffer)
	}
	h.unwatch("r", keeping)
	h.publish("r", NodeEvent{Node: "after", Kind: engine.EventStarted})
	select {
	case e := <-keeping:
		t.Errorf("an unwatched channel got %s", seqs([]Event{e}))
	default:
	}
}

func TestHub_ForgetsARunAMinuteAfterItEnds(t *testing.T) {
	t.Parallel()
	synctest.Test(t, func(t *testing.T) {
		h := newHub()
		h.open("r")
		h.end("r", store.Run{Status: "failed"})
		time.Sleep(keep - time.Second)
		if _, _, _, ok := h.watch("r", 0); !ok {
			t.Fatal("forgotten before the minute was up")
		}
		time.Sleep(2 * time.Second)
		synctest.Wait()
		if _, _, _, ok := h.watch("r", 0); ok {
			t.Error("still held after a minute")
		}
	})
}
