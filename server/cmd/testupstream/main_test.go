package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandler_AnswersKnownRequests(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(handler())
	t.Cleanup(srv.Close)

	for _, tc := range []struct {
		method, path, body string
		status             int
		field, want        string
	}{
		{"GET", "/users/7", "", http.StatusOK, "email", "user7@example.com"},
		{"GET", "/users/99", "", http.StatusNotFound, "error", "not found"},
		{"POST", "/users", `{"name": "Ada"}`, http.StatusCreated, "name", "Ada"},
		{"GET", "/prefs/7", "", http.StatusOK, "language", "en"},
		{"POST", "/contacts", `{"email": "a@example.com"}`, http.StatusCreated, "id", "c-1"},
		{"GET", "/status/503", "", http.StatusServiceUnavailable, "error", "Service Unavailable"},
		{"GET", "/slow?ms=1", "", http.StatusOK, "slept", "1ms"},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			t.Parallel()
			req, err := http.NewRequestWithContext(t.Context(), tc.method, srv.URL+tc.path, strings.NewReader(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			res, err := srv.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != tc.status {
				t.Errorf("status = %d, want %d", res.StatusCode, tc.status)
			}
			var got map[string]any
			if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
				t.Fatal(err)
			}
			if got[tc.field] != tc.want {
				t.Errorf("%s = %v, want %q", tc.field, got[tc.field], tc.want)
			}
		})
	}
}

func TestHandler_ListsAUsersOrders(t *testing.T) {
	t.Parallel()
	rec := httptest.NewRecorder()
	handler().ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), "GET", "/orders?user_id=7", nil))
	var got struct {
		Orders []struct {
			UserID string `json:"user_id"`
		} `json:"orders"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.Orders) != 2 || got.Orders[0].UserID != "7" {
		t.Errorf("orders = %+v, want two of user 7's", got.Orders)
	}
}

func TestHandler_RefusesAStatusItCantSend(t *testing.T) {
	t.Parallel()
	rec := httptest.NewRecorder()
	handler().ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), "GET", "/status/42", nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}
