package upstream

import (
	"fmt"
	"testing"
	"time"
)

// The same cases as the learning repo's retry table, with this package's
// 100 ms base, 10 s cap and 30 s Retry-After ceiling. The random draw is the
// middle of the window, so every line can be checked by hand.
func TestDelay(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	mid := func(n int64) int64 { return n / 2 }
	hour := time.Hour
	tests := []struct {
		retry      int
		retryAfter string
		budget     time.Duration
		want       string
	}{
		{1, "", hour, "50ms"},
		{2, "", hour, "100ms"},
		{3, "", hour, "200ms"},
		{7, "", hour, "3.2s"},
		{8, "", hour, "5s"},
		{40, "", hour, "5s"},
		{1, "20", hour, "20.05s"},
		{1, "20", 10 * time.Second, "give up"}, // asks for more than the run has left
		{1, "120", hour, "give up"},            // asks for more than 30 s
		{2, "Mon, 19 Oct 2026 12:00:20 GMT", hour, "20.1s"},
		{2, "Monday, 19-Oct-26 12:00:20 GMT", hour, "20.1s"},
		{2, "Mon Oct 19 12:00:20 2026", hour, "20.1s"},
		{2, "Mon, 19 Oct 2026 11:00:00 GMT", hour, "100ms"}, // a date in the past is no wait
		{3, "+5", hour, "200ms"},                            // malformed values are ignored
		{3, "1.5", hour, "200ms"},
		{3, "99999999999", hour, "give up"},
		{8, "", 3 * time.Second, "3s"}, // clipped to what's left
	}
	for _, tt := range tests {
		d, ok := delay(tt.retry, tt.retryAfter, now, tt.budget, mid)
		got := "give up"
		if ok {
			got = d.String()
		}
		if got != tt.want {
			t.Errorf("delay(%d, %q, %v) = %s, want %s", tt.retry, tt.retryAfter, tt.budget, got, tt.want)
		}
	}
}

func TestRetryable(t *testing.T) {
	t.Parallel()
	tests := []struct {
		err  *Error
		want bool
	}{
		{&Error{Kind: KindTransport}, true},
		{&Error{Kind: KindTimeout}, true},
		{&Error{Kind: KindStatus, Status: 429}, true},
		{&Error{Kind: KindStatus, Status: 503}, true},
		{&Error{Kind: KindStatus, Status: 500}, true},
		{&Error{Kind: KindStatus, Status: 404}, false},
		{&Error{Kind: KindStatus, Status: 302}, false},
		{&Error{Kind: KindBlocked}, false},
		{&Error{Kind: KindTooLarge}, false},
		{&Error{Kind: KindDecode}, false},
	}
	for _, tt := range tests {
		if got := retryable(tt.err); got != tt.want {
			t.Errorf("retryable(%s) = %v, want %v", fmt.Sprint(tt.err.Kind, " ", tt.err.Status), got, tt.want)
		}
	}
}
