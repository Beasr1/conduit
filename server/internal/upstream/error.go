package upstream

import (
	"fmt"
	"net/url"
	"strings"
)

// Kind is what went wrong with a call.
type Kind string

const (
	KindTransport Kind = "transport" // no usable exchange: DNS, refused, reset
	KindTimeout   Kind = "timeout"   // an attempt ran out of time
	KindStatus    Kind = "status"    // the upstream answered, but not with 2xx
	KindDecode    Kind = "decode"    // a 2xx body that isn't JSON
	KindBlocked   Kind = "blocked"   // the address or port isn't allowed
	KindTooLarge  Kind = "too_large" // the body is over the cap
)

// Error is a failed call.
type Error struct {
	Kind     Kind
	Method   string
	URL      string // without the query string, which may hold secrets
	Status   int    // for KindStatus
	Attempts int
	Err      error // the cause; nil for KindStatus
}

func newError(kind Kind, r *Request, err error) *Error {
	return &Error{Kind: kind, Method: r.Method, URL: withoutQuery(r.URL), Err: err}
}

func (e *Error) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s: ", e.Method, e.URL)
	if e.Kind == KindStatus {
		fmt.Fprintf(&b, "status %d", e.Status)
	} else {
		fmt.Fprintf(&b, "%s: %v", e.Kind, e.Err)
	}
	if e.Attempts > 1 {
		fmt.Fprintf(&b, " after %d attempts", e.Attempts)
	}
	return b.String()
}

func (e *Error) Unwrap() error { return e.Err }

func withoutQuery(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "(unparsable url)"
	}
	u.RawQuery, u.Fragment, u.User = "", "", nil
	return u.String()
}
