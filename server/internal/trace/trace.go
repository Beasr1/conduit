// Package trace carries W3C Trace Context (https://www.w3.org/TR/trace-context/)
// through Conduit: the trace a request belongs to, and how many times it
// has passed through Conduit on the way. A run's calls pass both on, one
// hop further, so a workflow that calls itself, directly or through other
// workflows or an API whose tracing passes them on, is refused once a
// request has gone round MaxHops times (plan 06).
package trace

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// MaxHops is how many times a request may pass through Conduit: the one
// that would pass through again is refused, so a loop goes round this many
// times.
const MaxHops = 8

// Trace is where a request stands in its trace.
type Trace struct {
	ID      string // 32 lowercase hex digits, not all zeros
	Hops    int    // the times Conduit has passed it on to get here
	sampled bool
	state   []string // the other members of its tracestate, in order
}

// key is Conduit's member of tracestate, and the hop count its value: h:3.
const key = "conduit"

// maxMembers is how many members a tracestate holds.
const maxMembers = 32

var (
	traceparent = regexp.MustCompile(`^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$`)
	member      = regexp.MustCompile(`^([a-z][a-z0-9_\-*/]{0,255}|[a-z0-9][a-z0-9_\-*/]{0,240}@[a-z][a-z0-9_\-*/]{0,13})=([ !-+\--<>-~]{0,255}[!-+\--<>-~])$`)
	hops        = regexp.MustCompile(`^h:([0-9]{1,3})$`)
)

// New starts a trace.
func New() Trace {
	return Trace{ID: random(16)}
}

// Read is the trace a request carries, or a new one when it carries none
// or its traceparent doesn't parse: then, as the spec says, "the vendor
// creates a new traceparent header and deletes tracestate". A tracestate
// member that doesn't parse is dropped on its own.
func Read(h http.Header) Trace {
	m := traceparent.FindStringSubmatch(h.Get("traceparent"))
	if m == nil || m[1] == "ff" || (m[1] == "00" && m[5] != "") ||
		strings.Trim(m[2], "0") == "" || strings.Trim(m[3], "0") == "" {
		return New()
	}
	flags, _ := strconv.ParseUint(m[4], 16, 8)
	t := Trace{ID: m[2], sampled: flags&1 == 1}
	seen := false
	for _, s := range strings.Split(strings.Join(h.Values("tracestate"), ","), ",") {
		mm := member.FindStringSubmatch(strings.Trim(s, " \t"))
		switch {
		case mm == nil:
		case mm[1] != key:
			t.state = append(t.state, mm[0])
		case !seen:
			seen = true
			if n := hops.FindStringSubmatch(mm[2]); n != nil {
				t.Hops, _ = strconv.Atoi(n[1])
			}
		}
	}
	return t
}

// Pass sets the trace on a call made for the request, overwriting what h
// had: a new parent id, as each call is an operation of its own, and
// Conduit's member first in tracestate, one hop further, then the others as
// they came. Flags other than sampled go out as zero.
func (t Trace) Pass(h http.Header) {
	id := t.ID
	if id == "" {
		id = New().ID
	}
	flags := "00"
	if t.sampled {
		flags = "01"
	}
	h.Set("traceparent", "00-"+id+"-"+random(8)+"-"+flags)
	state := append([]string{key + "=h:" + strconv.Itoa(t.Hops+1)}, t.state...)
	h.Set("tracestate", strings.Join(state[:min(len(state), maxMembers)], ","))
}

// Next is t one hop further: what a run of a workflow a step uses carries,
// as it runs inside the server rather than through a call (plan 07).
func (t Trace) Next() Trace {
	t.Hops++
	return t
}

type contextKey struct{}

// With is ctx carrying t.
func With(ctx context.Context, t Trace) context.Context {
	return context.WithValue(ctx, contextKey{}, t)
}

// From is the trace ctx carries, if it carries one.
func From(ctx context.Context) (Trace, bool) {
	t, ok := ctx.Value(contextKey{}).(Trace)
	return t, ok
}

// random is n random bytes in lowercase hex, not all zeros, as an id may
// not be.
func random(n int) string {
	b := make([]byte, n)
	for {
		_, _ = rand.Read(b) // crypto/rand's Read never fails
		if strings.Trim(string(b), "\x00") != "" {
			return hex.EncodeToString(b)
		}
	}
}
