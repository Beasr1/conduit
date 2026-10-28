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

const (
	// keepAlive is how often an idle stream sends a comment line, well
	// inside nginx's 40 s proxy_read_timeout.
	keepAlive = 15 * time.Second
	// writeWait bounds each write. It takes the place of the server's
	// WriteTimeout, which would cut a stream that outlives it. Clearing the
	// deadline instead would let a client that stops reading hold its
	// handler, and the connection, for ever.
	writeWait = 10 * time.Second
)

// events is what a stream reads: a run's events in order, the run's own
// last, then io.EOF. *runner.Watch is the one implementation; the tests
// have their own.
type events interface {
	Next(ctx context.Context) ([]runner.Event, error)
}

// eventStream writes a run's events as server-sent events, each batch
// flushed as it comes. The generated response type copies a reader to the
// end before anything is flushed.
type eventStream struct {
	ctx     context.Context // the request's: done once the client goes away
	events  events
	log     *slog.Logger
	release func() // frees the stream's place under the cap; nil for none
}

func (s eventStream) VisitStreamRunEventsResponse(w http.ResponseWriter) error {
	if s.release != nil {
		defer s.release()
	}
	rc := http.NewResponseController(w)
	deadline := func() error {
		if err := rc.SetWriteDeadline(time.Now().Add(writeWait)); err != nil && !errors.Is(err, http.ErrNotSupported) {
			return err
		}
		return nil
	}
	if err := deadline(); err != nil {
		return fmt.Errorf("set the write deadline: %w", err)
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no") // nginx passes each event on as it comes
	w.WriteHeader(http.StatusOK)

	// Once the status is out, an error can't change the answer: a write
	// that fails or times out means the client has gone, or stopped reading,
	// and the stream just ends.
	send := func(b []byte) bool {
		if deadline() != nil {
			return false
		}
		_, err := w.Write(b)
		return err == nil
	}
	flush := func() bool { return rc.Flush() == nil }
	if !flush() {
		return nil
	}
	for {
		wait, cancel := context.WithTimeout(s.ctx, keepAlive)
		batch, err := s.events.Next(wait)
		cancel()
		switch {
		case errors.Is(err, io.EOF):
			return nil
		case errors.Is(err, context.DeadlineExceeded) && s.ctx.Err() == nil:
			if !send([]byte(": keep-alive\n\n")) || !flush() {
				return nil
			}
			continue
		case err != nil:
			if s.ctx.Err() == nil {
				s.log.ErrorContext(s.ctx, "read a run's events", "err", err)
			}
			return nil
		}
		for _, e := range batch {
			b, err := eventBytes(e)
			if err != nil {
				s.log.ErrorContext(s.ctx, "encode a run event", "err", err)
				return nil
			}
			if !send(b) {
				return nil
			}
		}
		if !flush() {
			return nil
		}
	}
}

// eventBytes is one event as the stream sends it: its id, its name, and its
// data as JSON on one line. A node event's id is its number; the run's is
// `end`, which a reconnect sends back to be told there's nothing more.
// encoding/json escapes line breaks inside strings, and compacts raw
// values, so the data never spans lines.
func eventBytes(e runner.Event) ([]byte, error) {
	var b bytes.Buffer
	switch {
	case e.Node != nil:
		j, err := json.Marshal(nodeEventOut(*e.Node))
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(&b, "id: %d\nevent: node\ndata: %s\n\n", e.Seq, j)
	case e.Run != nil:
		run, err := runOut(*e.Run)
		if err != nil {
			return nil, err
		}
		j, err := json.Marshal(run)
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(&b, "id: end\nevent: run\ndata: %s\n\n", j)
	}
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
