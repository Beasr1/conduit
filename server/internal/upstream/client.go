// Package upstream is the server's only way to make outbound HTTP calls.
//
// It refuses non-public addresses when it dials, after DNS has resolved the
// name, so a hostname that resolves inward and a redirect to an internal
// address fail alike. It also times out each attempt, caps response bodies,
// retries what is safe to retry, and reports failures as a Kind.
package upstream

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"time"

	"code.dny.dev/ssrf"
)

const (
	defaultTimeout = 30 * time.Second
	maxBody        = 10 << 20
	maxRedirects   = 5
)

// Azure's host address (wireserver) is in no special-purpose range, so the
// guard's list doesn't cover it.
var azureHost = netip.MustParsePrefix("168.63.129.16/32")

// Options configure a Client. The zero value is the safe default.
type Options struct {
	// AllowPrivateNetworks turns the address check off, so local development
	// can call services on localhost. Never in production.
	AllowPrivateNetworks bool
	// Ports upstreams may use. Empty means 80 and 443.
	Ports []uint16
}

// Client calls upstreams. It's safe for concurrent use.
type Client struct {
	http *http.Client
}

// New returns a Client with the address check on unless o turns it off.
func New(o Options) *Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	if !o.AllowPrivateNetworks {
		opts := []ssrf.Option{ssrf.WithDeniedV4Prefixes(azureHost)}
		if len(o.Ports) > 0 {
			opts = append(opts, ssrf.WithPorts(o.Ports...))
		}
		dialer.Control = ssrf.New(opts...).Safe
	}
	return newClient(dialer)
}

func newClient(dialer *net.Dialer) *Client {
	transport := &http.Transport{
		// No proxy: a proxy would dial the upstream itself, past the check.
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	return &Client{http: &http.Client{
		Transport: transport,
		// Past five redirects, or off http(s), the last response is returned
		// and fails as a status error. Each hop is dialled, so checked.
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > maxRedirects || (req.URL.Scheme != "http" && req.URL.Scheme != "https") {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}}
}

// Request is one call, retries included.
type Request struct {
	Method string
	URL    string // absolute
	Header http.Header
	Body   []byte // JSON, or nil for none

	Timeout  time.Duration // for each attempt; zero means 30 s
	Attempts int           // in total; 0 or 1 means no retry
	// Idempotent says the upstream treats repeats as one request, so a POST
	// or PATCH may be retried. GET, HEAD, PUT and DELETE always may.
	Idempotent bool
	// OnRetry, if set, is called as each retry starts, with its attempt
	// number: 2, then 3, and so on.
	OnRetry func(attempt int)
}

// Response is an upstream's answer.
type Response struct {
	Status int
	Header http.Header
	Body   json.RawMessage // nil when there was no body, or it wasn't JSON
}

// Do sends r, retrying as r allows. A response that isn't 2xx is an *Error
// of KindStatus, and Do returns the response with it.
func (c *Client) Do(ctx context.Context, r *Request) (*Response, error) {
	attempts := max(r.Attempts, 1)
	if !r.Idempotent && r.Method != http.MethodGet && r.Method != http.MethodHead &&
		r.Method != http.MethodPut && r.Method != http.MethodDelete {
		attempts = 1
	}
	for n := 1; ; n++ {
		res, err := c.attempt(ctx, r)
		if err == nil {
			return res, nil
		}
		err.Attempts = n
		if n == attempts || !retryable(err) || ctx.Err() != nil {
			return res, err
		}
		var retryAfter string
		if res != nil {
			retryAfter = res.Header.Get("Retry-After")
		}
		wait, ok := delay(n, retryAfter, time.Now(), budget(ctx), rand.Int64N)
		if !ok {
			return res, err
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return res, err
		case <-timer.C:
		}
		if r.OnRetry != nil {
			r.OnRetry(n + 1)
		}
	}
}

// budget is what's left before ctx's deadline.
func budget(ctx context.Context) time.Duration {
	if d, ok := ctx.Deadline(); ok {
		return time.Until(d)
	}
	return time.Duration(1<<63 - 1)
}

func (c *Client) attempt(ctx context.Context, r *Request) (*Response, *Error) {
	ctx, cancel := context.WithTimeout(ctx, cmp.Or(r.Timeout, defaultTimeout))
	defer cancel()

	var body io.Reader
	if r.Body != nil {
		body = bytes.NewReader(r.Body)
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, r.URL, body)
	if err != nil {
		return nil, newError(KindTransport, r, err)
	}
	for k, v := range r.Header {
		req.Header[k] = v
	}
	if r.Body != nil && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if req.Header.Get("Accept") == "" {
		req.Header.Set("Accept", "application/json")
	}

	res, err := c.http.Do(req)
	if err != nil {
		return nil, classify(ctx, r, err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxBody+1))
	if err != nil {
		return nil, classify(ctx, r, err)
	}
	if len(raw) > maxBody {
		return nil, newError(KindTooLarge, r, errors.New("the response body is over 10 MiB"))
	}

	out := &Response{Status: res.StatusCode, Header: res.Header}
	ok := res.StatusCode >= 200 && res.StatusCode <= 299
	if len(bytes.TrimSpace(raw)) > 0 {
		if json.Valid(raw) {
			out.Body = raw
		} else if ok {
			return out, newError(KindDecode, r, errors.New("the response body isn't JSON"))
		}
	}
	if !ok {
		e := newError(KindStatus, r, nil)
		e.Status = res.StatusCode
		return out, e
	}
	return out, nil
}

// classify names a failed exchange. The attempt's own context tells a
// timeout apart; the guard's sentinels tell a block apart.
func classify(ctx context.Context, r *Request, err error) *Error {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err // its message repeats the URL, query string and all
	}
	switch {
	case errors.Is(err, ssrf.ErrProhibitedIP), errors.Is(err, ssrf.ErrProhibitedPort), errors.Is(err, ssrf.ErrProhibitedNetwork):
		return newError(KindBlocked, r, err)
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return newError(KindTimeout, r, err)
	default:
		return newError(KindTransport, r, err)
	}
}
