package upstream

import (
	"errors"
	"math"
	"net/http"
	"strconv"
	"time"
)

const (
	backoffBase = 100 * time.Millisecond
	backoffCap  = 10 * time.Second
	// A server asking for a longer pause than this has failed the call: a
	// served run's whole budget is 30 s.
	maxRetryAfter = 30 * time.Second
)

// retryable reports whether a failure may succeed if sent again: no usable
// exchange, a timeout, 429, or a 5xx.
func retryable(e *Error) bool {
	switch e.Kind {
	case KindTransport, KindTimeout:
		return true
	case KindStatus:
		return e.Status == http.StatusTooManyRequests || e.Status >= 500
	default:
		return false
	}
}

// delay is how long to wait before retry number retry (1 for the first):
// capped exponential backoff with full jitter. A Retry-After value is a
// floor, with the jitter on top so clients told the same second don't return
// together. ok is false when the server asks for more than budget, or more
// than 30 s: give up now rather than sleep first. rnd(n) returns a uniform
// value in [0, n).
func delay(retry int, retryAfter string, now time.Time, budget time.Duration, rnd func(int64) int64) (d time.Duration, ok bool) {
	window := backoffBase
	for i := 1; i < retry && window < backoffCap; i++ {
		window *= 2
	}
	d = time.Duration(rnd(int64(min(window, backoffCap))))
	if floor, has := parseRetryAfter(retryAfter, now); has {
		if floor > min(budget, maxRetryAfter) {
			return 0, false
		}
		d += floor
	}
	return min(d, budget), true
}

// parseRetryAfter reads RFC 9110 §10.2.3: delay-seconds or an HTTP-date. A
// value it can't parse is ignored.
func parseRetryAfter(v string, now time.Time) (time.Duration, bool) {
	if v == "" {
		return 0, false
	}
	// ParseUint, not Atoi: Atoi accepts "+5" and "-5".
	secs, err := strconv.ParseUint(v, 10, 32)
	if err == nil {
		return time.Duration(secs) * time.Second, true
	}
	if errors.Is(err, strconv.ErrRange) {
		return math.MaxInt64, true
	}
	t, err := http.ParseTime(v) // all three HTTP-date formats
	if err != nil {
		return 0, false
	}
	return max(t.Sub(now), 0), true
}
