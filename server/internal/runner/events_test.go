package runner

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/Beasr1/conduit/server/internal/engine"
)

// seqs renders events as "1 a started, end run succeeded".
func seqs(events []Event) string {
	var out []string
	for _, e := range events {
		switch {
		case e.Node != nil:
			out = append(out, fmt.Sprintf("%d %s %s", e.Seq, e.Node.Node, e.Node.Kind))
		case e.Run != nil:
			out = append(out, "end run "+e.Run.Status)
		}
	}
	return strings.Join(out, ", ")
}

func TestHub_HandsOutWhatsAfterAPosition(t *testing.T) {
	t.Parallel()
	h := newHub()
	h.open("r")
	h.publish("r", NodeEvent{Node: "a", Kind: engine.EventStarted})
	h.publish("r", NodeEvent{Node: "a", Kind: engine.EventSucceeded})

	events, ended, changed, ok := h.since("r", 1)
	if !ok || ended || seqs(events) != "2 a succeeded" {
		t.Fatalf("since 1 = %s, ended %v, ok %v", seqs(events), ended, ok)
	}
	if events, _, _, _ := h.since("r", 2); len(events) != 0 {
		t.Errorf("since the last = %s, want nothing", seqs(events))
	}
	h.publish("r", NodeEvent{Node: "b", Kind: engine.EventStarted})
	select {
	case <-changed:
	default:
		t.Fatal("publishing didn't close the channel since returned")
	}
	h.end("r")
	events, ended, _, _ = h.since("r", 0)
	if !ended || seqs(events) != "1 a started, 2 a succeeded, 3 b started" {
		t.Errorf("since 0 once ended = %s, ended %v", seqs(events), ended)
	}
	if _, _, _, ok := h.since("other", 0); ok {
		t.Error("since on an unknown run: ok")
	}
}

// A client far behind holds no buffer and loses nothing: it takes what's
// after its position, however much that is.
func TestHub_AClientFarBehindGetsEverything(t *testing.T) {
	t.Parallel()
	h := newHub()
	h.open("r")
	for i := range 10_000 {
		h.publish("r", NodeEvent{Node: fmt.Sprint(i), Kind: engine.EventStarted})
	}
	events, _, _, _ := h.since("r", 0)
	if len(events) != 10_000 || events[0].Seq != 1 || events[9_999].Seq != 10_000 {
		t.Errorf("since 0 = %d events, from %d to %d", len(events), events[0].Seq, events[len(events)-1].Seq)
	}
}

func TestHub_WakesEveryoneWaiting(t *testing.T) {
	t.Parallel()
	h := newHub()
	h.open("r")
	var woke sync.WaitGroup
	for range 3 {
		_, _, changed, _ := h.since("r", 0)
		woke.Go(func() { <-changed })
	}
	h.end("r")
	done := make(chan struct{})
	go func() { woke.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("ending the run didn't wake every waiter")
	}
}

func TestHub_ForgetsARunAMinuteAfterItEnds(t *testing.T) {
	t.Parallel()
	synctest.Test(t, func(t *testing.T) {
		h := newHub()
		h.open("r")
		h.end("r")
		time.Sleep(keep - time.Second)
		if _, _, _, ok := h.since("r", 0); !ok {
			t.Fatal("forgotten before the minute was up")
		}
		time.Sleep(2 * time.Second)
		synctest.Wait()
		if _, _, _, ok := h.since("r", 0); ok {
			t.Error("still held after a minute")
		}
	})
}
