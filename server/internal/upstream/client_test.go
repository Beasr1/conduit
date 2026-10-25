package upstream

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"code.dny.dev/ssrf"
)

// loopbackClient reaches httptest servers on 127.0.0.1 and nothing else
// private: the guard is on, with that one address allowed.
func loopbackClient() *Client {
	g := ssrf.New(ssrf.WithAnyPort(), ssrf.WithAllowedV4Prefixes(netip.MustParsePrefix("127.0.0.1/32")))
	return newClient(&net.Dialer{Timeout: time.Second, Control: g.Safe})
}

func get(url string) *Request {
	return &Request{Method: http.MethodGet, URL: url}
}

func kindOf(t *testing.T, err error) Kind {
	t.Helper()
	var ue *Error
	if !errors.As(err, &ue) {
		t.Fatalf("error %v (%T) isn't an *upstream.Error", err, err)
	}
	return ue.Kind
}

func TestDo_BlocksNonPublicAddresses(t *testing.T) {
	t.Parallel()
	c := New(Options{})
	for _, target := range []string{
		"http://127.0.0.1/",              // loopback
		"http://10.0.0.1/",               // RFC 1918
		"http://172.16.0.1/",             // RFC 1918
		"http://192.168.1.1/",            // RFC 1918
		"http://169.254.169.254/latest/", // link-local: cloud metadata
		"http://100.64.0.1/",             // CGNAT
		"http://0.0.0.0/",                // "this network"
		"http://[::1]/",                  // IPv6 loopback
		"http://[fd00:ec2::254]/",        // ULA: the IPv6 metadata address
		"http://[fe80::1]/",              // IPv6 link-local
		"http://[::ffff:127.0.0.1]/",     // IPv4-mapped IPv6
		"http://168.63.129.16/",          // Azure's host address: public, but not ours
		"http://1.1.1.1:8080/",           // a public address on a port that isn't allowed
		"http://localhost/",              // a name that resolves inward
	} {
		t.Run(target, func(t *testing.T) {
			t.Parallel()
			_, err := c.Do(t.Context(), get(target))
			if err == nil {
				t.Fatal("Do() succeeded, want it blocked")
			}
			if k := kindOf(t, err); k != KindBlocked {
				t.Errorf("kind = %s (%v), want blocked", k, err)
			}
		})
	}
}

func TestDo_DefaultRefusesLoopbackServer(t *testing.T) {
	t.Parallel()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer srv.Close()

	// httptest listens on a high port, so allow any port: the address alone
	// must be what's refused.
	c := newClient(&net.Dialer{Control: ssrf.New(ssrf.WithAnyPort()).Safe})
	_, err := c.Do(t.Context(), get(srv.URL))
	if k := kindOf(t, err); k != KindBlocked {
		t.Errorf("kind = %s (%v), want blocked", k, err)
	}
	if hits.Load() != 0 {
		t.Error("the server was reached")
	}
}

func TestDo_DecimalHostDoesNotReachLoopback(t *testing.T) {
	t.Parallel()
	// 2130706433 is 127.0.0.1 written as one number. Some resolvers accept
	// it (macOS does) and the guard blocks the address; others fail the
	// lookup. Either way nothing local is reached.
	_, err := New(Options{}).Do(t.Context(), get("http://2130706433/"))
	if err == nil {
		t.Fatal("Do() succeeded")
	}
	if k := kindOf(t, err); k != KindBlocked && k != KindTransport {
		t.Errorf("kind = %s (%v), want blocked or transport", k, err)
	}
}

func TestDo_BlocksRedirectToInternalAddress(t *testing.T) {
	t.Parallel()
	for _, to := range []string{"http://127.0.0.2/admin", "http://169.254.169.254/latest/meta-data/"} {
		t.Run(to, func(t *testing.T) {
			t.Parallel()
			srv := httptest.NewServer(http.RedirectHandler(to, http.StatusFound))
			defer srv.Close()
			_, err := loopbackClient().Do(t.Context(), get(srv.URL))
			if k := kindOf(t, err); k != KindBlocked {
				t.Errorf("kind = %s (%v), want blocked", k, err)
			}
		})
	}
}

func TestDo_AllowPrivateNetworksReachesLoopback(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"ok":true}`)
	}))
	defer srv.Close()
	res, err := New(Options{AllowPrivateNetworks: true}).Do(t.Context(), get(srv.URL))
	if err != nil {
		t.Fatal(err)
	}
	if string(res.Body) != `{"ok":true}` {
		t.Errorf("body = %s", res.Body)
	}
}

func TestDo_SendsJSONAndKeepsCallerHeaders(t *testing.T) {
	t.Parallel()
	var gotType, gotAccept, gotKey, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotType, gotAccept, gotKey = r.Header.Get("Content-Type"), r.Header.Get("Accept"), r.Header.Get("X-Api-Key")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusCreated)
		fmt.Fprint(w, `{"id":7}`)
	}))
	defer srv.Close()

	res, err := loopbackClient().Do(t.Context(), &Request{
		Method: http.MethodPost,
		URL:    srv.URL,
		Header: http.Header{"X-Api-Key": {"k"}, "Accept": {"application/vnd.x+json"}},
		Body:   []byte(`{"email":"ada@example.com"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != http.StatusCreated || string(res.Body) != `{"id":7}` {
		t.Errorf("response = %d %s", res.Status, res.Body)
	}
	if gotType != "application/json" || gotAccept != "application/vnd.x+json" || gotKey != "k" {
		t.Errorf("headers: Content-Type %q, Accept %q, X-Api-Key %q", gotType, gotAccept, gotKey)
	}
	if gotBody != `{"email":"ada@example.com"}` {
		t.Errorf("body sent = %s", gotBody)
	}
}

func TestDo_ResponseBodies(t *testing.T) {
	t.Parallel()
	big := strings.Repeat("x", maxBody-2)
	tests := []struct {
		name   string
		status int
		body   string
		kind   Kind // "" for success
		want   string
	}{
		{"empty is null", http.StatusNoContent, "", "", ""},
		{"whitespace is null", http.StatusOK, " \n", "", ""},
		{"exactly the cap", http.StatusOK, `"` + big + `"`, "", `"` + big + `"`},
		{"over the cap", http.StatusOK, `"` + big + `x"`, KindTooLarge, ""},
		{"not JSON", http.StatusOK, "<html>", KindDecode, ""},
		{"a 404 is a status error, body kept", http.StatusNotFound, `{"error":"no such user"}`, KindStatus, `{"error":"no such user"}`},
		{"a 500 with an HTML page is a status error", http.StatusInternalServerError, "<html>", KindStatus, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tt.status)
				fmt.Fprint(w, tt.body)
			}))
			defer srv.Close()
			res, err := loopbackClient().Do(t.Context(), get(srv.URL))
			if tt.kind == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if k := kindOf(t, err); k != tt.kind {
				t.Fatalf("kind = %s (%v), want %s", k, err, tt.kind)
			}
			var gotBody string
			if res != nil {
				gotBody = string(res.Body)
			}
			if gotBody != tt.want {
				t.Errorf("body = %.40q, want %.40q", gotBody, tt.want)
			}
		})
	}
}

func TestDo_TimesOutEachAttempt(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}))
	defer srv.Close()
	r := get(srv.URL)
	r.Timeout = 50 * time.Millisecond
	start := time.Now()
	_, err := loopbackClient().Do(t.Context(), r)
	if k := kindOf(t, err); k != KindTimeout {
		t.Errorf("kind = %s (%v), want timeout", k, err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("took %v, want about 50ms", elapsed)
	}
}

// flaky answers with the given statuses in turn, then 200.
func flaky(hits *atomic.Int32, header http.Header, statuses ...int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		n := int(hits.Add(1))
		if n <= len(statuses) {
			for k, v := range header {
				w.Header()[k] = v
			}
			w.WriteHeader(statuses[n-1])
			return
		}
		fmt.Fprint(w, `{"ok":true}`)
	}
}

func TestDo_Retries(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		method     string
		idempotent bool
		statuses   []int
		attempts   int
		wantHits   int32
		wantErr    bool
	}{
		{"GET retries a 503", http.MethodGet, false, []int{503, 503}, 3, 3, false},
		{"GET gives up after its attempts", http.MethodGet, false, []int{503, 503, 503}, 2, 2, true},
		{"a 404 isn't retried", http.MethodGet, false, []int{404}, 3, 1, true},
		{"POST isn't retried by default", http.MethodPost, false, []int{503}, 3, 1, true},
		{"an idempotent POST is retried", http.MethodPost, true, []int{503}, 3, 2, false},
		{"no retry without attempts", http.MethodGet, false, []int{503}, 0, 1, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var hits atomic.Int32
			srv := httptest.NewServer(flaky(&hits, nil, tt.statuses...))
			defer srv.Close()
			var retries []int
			_, err := loopbackClient().Do(t.Context(), &Request{
				Method: tt.method, URL: srv.URL, Attempts: tt.attempts, Idempotent: tt.idempotent,
				OnRetry: func(n int) { retries = append(retries, n) },
			})
			if (err != nil) != tt.wantErr {
				t.Fatalf("error = %v, want error %v", err, tt.wantErr)
			}
			if hits.Load() != tt.wantHits {
				t.Errorf("hits = %d, want %d", hits.Load(), tt.wantHits)
			}
			if len(retries) != int(tt.wantHits)-1 {
				t.Errorf("OnRetry calls = %v, want %d", retries, tt.wantHits-1)
			}
			for i, n := range retries {
				if n != i+2 {
					t.Errorf("OnRetry got attempt %d, want %d", n, i+2)
				}
			}
		})
	}
}

func TestDo_HonoursRetryAfter(t *testing.T) {
	t.Parallel()
	var hits atomic.Int32
	srv := httptest.NewServer(flaky(&hits, http.Header{"Retry-After": {"1"}}, 429))
	defer srv.Close()
	r := get(srv.URL)
	r.Attempts = 2
	start := time.Now()
	if _, err := loopbackClient().Do(t.Context(), r); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed < time.Second {
		t.Errorf("retried after %v, want at least the 1 s the server asked for", elapsed)
	}
}

func TestDo_GivesUpWhenRetryAfterIsTooLong(t *testing.T) {
	t.Parallel()
	var hits atomic.Int32
	srv := httptest.NewServer(flaky(&hits, http.Header{"Retry-After": {"120"}}, 503))
	defer srv.Close()
	r := get(srv.URL)
	r.Attempts = 3
	start := time.Now()
	_, err := loopbackClient().Do(t.Context(), r)
	if k := kindOf(t, err); k != KindStatus {
		t.Errorf("kind = %s, want status", k)
	}
	if hits.Load() != 1 || time.Since(start) > time.Second {
		t.Errorf("hits = %d after %v, want 1 and no waiting", hits.Load(), time.Since(start))
	}
}

func TestDo_StopsAfterFiveRedirects(t *testing.T) {
	t.Parallel()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Redirect(w, r, "/again", http.StatusFound)
	}))
	defer srv.Close()
	res, err := loopbackClient().Do(t.Context(), get(srv.URL))
	if k := kindOf(t, err); k != KindStatus || res.Status != http.StatusFound {
		t.Errorf("kind = %s, status %d; want a status error for the last 302", k, res.Status)
	}
	if hits.Load() != 6 {
		t.Errorf("hits = %d, want 6: the request and five redirects", hits.Load())
	}
}

func TestError_LeavesOutTheQuery(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()
	_, err := loopbackClient().Do(t.Context(), get(srv.URL+"/v1/users?api_key=s3cret"))
	if err == nil || strings.Contains(err.Error(), "s3cret") || !strings.Contains(err.Error(), "/v1/users") {
		t.Errorf("error = %v; want the path without the query", err)
	}

	_, err = New(Options{}).Do(t.Context(), get("http://127.0.0.1/v1?api_key=s3cret"))
	if err == nil || strings.Contains(err.Error(), "s3cret") {
		t.Errorf("error = %v; want no query", err)
	}
}
