package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/runner"
)

// keepAlive is how often an idle stream sends a comment line, well inside
// nginx's 40 s proxy_read_timeout.
const keepAlive = 15 * time.Second

// eventStream writes a run's events as server-sent events, each flushed as
// it comes. The generated response type copies a reader to the end before
// anything is flushed.
type eventStream struct {
	ctx   context.Context // the request's: done once the client goes away
	watch *runner.Watch
	log   *slog.Logger
}

func (s eventStream) VisitStreamRunEventsResponse(w http.ResponseWriter) error {
	defer s.watch.Close()
	rc := http.NewResponseController(w)
	// The server's WriteTimeout would cut the stream off. It ends with its
	// run, or its client, instead.
	if err := rc.SetWriteDeadline(time.Time{}); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return fmt.Errorf("clear the write deadline: %w", err)
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no") // nginx passes each event on as it comes
	w.WriteHeader(http.StatusOK)

	// Once the status is out, an error can't change the answer: a write
	// that fails means the client has gone, and the stream just ends.
	send := func(e runner.Event) bool {
		b, err := eventBytes(e)
		if err != nil {
			s.log.ErrorContext(s.ctx, "encode a run event", "err", err)
			return false
		}
		if _, err := w.Write(b); err != nil {
			return false
		}
		return rc.Flush() == nil
	}
	for _, e := range s.watch.Events {
		if !send(e) {
			return nil
		}
	}
	if s.watch.Live == nil || rc.Flush() != nil {
		return nil
	}
	tick := time.NewTicker(keepAlive)
	defer tick.Stop()
	for {
		select {
		case e, ok := <-s.watch.Live:
			// Closed early, this client fell behind: it reconnects with
			// Last-Event-ID and catches up.
			if !ok || !send(e) || e.Run != nil {
				return nil
			}
		case <-tick.C:
			if _, err := io.WriteString(w, ": keep-alive\n\n"); err != nil || rc.Flush() != nil {
				return nil
			}
		case <-s.ctx.Done():
			return nil
		}
	}
}

// eventBytes is one event as the stream sends it: its id, unless it has
// none, its name, and its data as JSON on one line. encoding/json escapes
// line breaks inside strings, and compacts raw values, so the data never
// spans lines.
func eventBytes(e runner.Event) ([]byte, error) {
	var name string
	var data any
	switch {
	case e.Node != nil:
		name, data = "node", nodeEventOut(*e.Node)
	case e.Run != nil:
		run, err := runOut(*e.Run)
		if err != nil {
			return nil, err
		}
		name, data = "run", run
	}
	j, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	if e.Seq > 0 {
		fmt.Fprintf(&b, "id: %d\n", e.Seq)
	}
	fmt.Fprintf(&b, "event: %s\ndata: %s\n\n", name, j)
	return b.Bytes(), nil
}

func nodeEventOut(e runner.NodeEvent) gen.NodeEvent {
	out := gen.NodeEvent{
		Node: e.Node, Kind: gen.NodeEventKind(e.Kind), Attempt: e.Attempt,
		At: e.At.UTC(), HTTPStatus: e.HTTPStatus,
	}
	if f := e.Failure; f != nil {
		out.Error = gen.RunError{Code: gen.RunErrorCode(f.Code), Detail: f.Detail}
	}
	return out
}
