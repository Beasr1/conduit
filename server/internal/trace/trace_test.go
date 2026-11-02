package trace

import (
	"context"
	"net/http"
	"regexp"
	"strings"
	"testing"
)

// The spec's own example.
const (
	exampleID     = "4bf92f3577b34da6a3ce929d0e0e4736"
	exampleParent = "00f067aa0ba902b7"
	example       = "00-" + exampleID + "-" + exampleParent + "-01"
)

func header(traceparent string, tracestate ...string) http.Header {
	h := http.Header{}
	if traceparent != "" {
		h.Set("traceparent", traceparent)
	}
	for _, s := range tracestate {
		h.Add("tracestate", s)
	}
	return h
}

// passed is what a call carries on: its traceparent's fields, and its
// tracestate.
func passed(t *testing.T, tr Trace) (id, parent, flags, state string) {
	t.Helper()
	h := http.Header{}
	tr.Pass(h)
	m := regexp.MustCompile(`^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$`).FindStringSubmatch(h.Get("traceparent"))
	if m == nil {
		t.Fatalf("traceparent = %q, want version 00", h.Get("traceparent"))
	}
	if strings.Trim(m[2], "0") == "" {
		t.Errorf("parent-id = %s, all zeros", m[2])
	}
	return m[1], m[2], m[3], h.Get("tracestate")
}

func TestRead_ContinuesTheCallersTrace(t *testing.T) {
	t.Parallel()
	tr := Read(header(example, "conduit=h:3, rojo=00f067aa0ba902b7", "congo=t61rcWkgMzE"))
	if tr.ID != exampleID || tr.Hops != 3 {
		t.Fatalf("Read() = %s at %d hops, want %s at 3", tr.ID, tr.Hops, exampleID)
	}
	id, parent, flags, state := passed(t, tr)
	if id != exampleID || flags != "01" {
		t.Errorf("passed on %s with flags %s, want %s with 01", id, flags, exampleID)
	}
	// Each call is an operation of its own, so it has its own parent id.
	if parent == exampleParent {
		t.Errorf("parent-id = the caller's, %s", parent)
	}
	if _, again, _, _ := passed(t, tr); again == parent {
		t.Errorf("two calls passed on parent-id %s both", parent)
	}
	// Conduit's entry first, one hop further; the rest as they came.
	if want := "conduit=h:4,rojo=00f067aa0ba902b7,congo=t61rcWkgMzE"; state != want {
		t.Errorf("tracestate = %q, want %q", state, want)
	}
}

// A traceparent that doesn't parse is ignored: the trace starts afresh, and
// its tracestate goes with it, hop count and all.
func TestRead_StartsATraceForOneThatDoesntParse(t *testing.T) {
	t.Parallel()
	for name, traceparent := range map[string]string{
		"none":               "",
		"uppercase":          "00-" + strings.ToUpper(exampleID) + "-" + exampleParent + "-01",
		"trace-id all zeros": "00-" + strings.Repeat("0", 32) + "-" + exampleParent + "-01",
		"parent-id all zero": "00-" + exampleID + "-" + strings.Repeat("0", 16) + "-01",
		"version ff":         "ff-" + exampleID + "-" + exampleParent + "-01",
		"version 00, longer": example + "-more",
		"a field short":      "00-" + exampleID[1:] + "-" + exampleParent + "-01",
		"not hex":            "00-" + exampleID[:31] + "g-" + exampleParent + "-01",
		"flags not hex":      "00-" + exampleID + "-" + exampleParent + "-0x",
		"no dashes":          "00_" + exampleID + "_" + exampleParent + "_01",
		"a higher version, its next field without a dash": "01-" + exampleID + "-" + exampleParent + "-01more",
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			tr := Read(header(traceparent, "conduit=h:7,rojo=1"))
			if tr.ID == exampleID || len(tr.ID) != 32 || tr.Hops != 0 {
				t.Errorf("Read() = %q at %d hops, want a new trace at 0", tr.ID, tr.Hops)
			}
			if _, _, flags, state := passed(t, tr); flags != "00" || state != "conduit=h:1" {
				t.Errorf("passed on flags %s and tracestate %q, want 00 and conduit=h:1", flags, state)
			}
		})
	}
}

// A later version may add fields after the flags; its first four are read,
// and it's passed on as version 00.
func TestRead_AHigherVersion(t *testing.T) {
	t.Parallel()
	for _, traceparent := range []string{
		"01-" + exampleID + "-" + exampleParent + "-01",
		"01-" + exampleID + "-" + exampleParent + "-01-what-comes-next",
	} {
		if tr := Read(header(traceparent)); tr.ID != exampleID {
			t.Errorf("Read(%q) started a trace, %s", traceparent, tr.ID)
		}
	}
}

// Flags other than sampled are set to zero on the way out.
func TestPass_KeepsOnlySampled(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]string{"01": "01", "03": "01", "02": "00", "00": "00", "ff": "01"} {
		tr := Read(header("00-" + exampleID + "-" + exampleParent + "-" + in))
		if _, _, flags, _ := passed(t, tr); flags != want {
			t.Errorf("flags %s passed on as %s, want %s", in, flags, want)
		}
	}
}

// tracestate's members are read leniently: an invalid one is dropped, and
// an empty one skipped. A hop count Conduit couldn't have sent is none.
func TestRead_Tracestate(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, tracestate, want string
		hops                   int
	}{
		{"none", "", "conduit=h:1", 0},
		{"Conduit's entry anywhere", "rojo=1,conduit=h:5", "conduit=h:6,rojo=1", 5},
		{"Conduit's entry twice, the first counting", "conduit=h:2,conduit=h:6", "conduit=h:3", 2},
		{"a hop count it couldn't have sent", "conduit=h:1234,rojo=1", "conduit=h:1,rojo=1", 0},
		{"not a hop count", "conduit=x", "conduit=h:1", 0},
		{"invalid members dropped", "Rojo=1, ,rojo=1=2,rojo=,congo=t61,a b=1", "conduit=h:1,congo=t61", 0},
		{"a multi-tenant key", "tenant@system=1", "conduit=h:1,tenant@system=1", 0},
		{"tabs and spaces around members", "\trojo=1 ,\tcongo=2", "conduit=h:1,rojo=1,congo=2", 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			tr := Read(header(example, tt.tracestate))
			if tr.Hops != tt.hops {
				t.Errorf("Hops = %d, want %d", tr.Hops, tt.hops)
			}
			if _, _, _, state := passed(t, tr); state != tt.want {
				t.Errorf("tracestate = %q, want %q", state, tt.want)
			}
		})
	}
}

// At most 32 members go on, Conduit's among them.
func TestPass_AtMost32Members(t *testing.T) {
	t.Parallel()
	members := make([]string, 40)
	for i := range members {
		members[i] = "v" + strings.Repeat("x", i) + "=1"
	}
	_, _, _, state := passed(t, Read(header(example, strings.Join(members, ","))))
	got := strings.Split(state, ",")
	if len(got) != 32 || got[0] != "conduit=h:1" || got[1] != members[0] || got[31] != members[30] {
		t.Errorf("tracestate has %d members, %s first and %s last; want 32, Conduit's then the first 31",
			len(got), got[0], got[len(got)-1])
	}
}

func TestContext(t *testing.T) {
	t.Parallel()
	if _, ok := From(context.Background()); ok {
		t.Error("From(an empty context) found a trace")
	}
	tr := New()
	if got, ok := From(With(context.Background(), tr)); !ok || got.ID != tr.ID {
		t.Errorf("From(With(%s)) = %s, %v", tr.ID, got.ID, ok)
	}
	if other := New(); other.ID == tr.ID || len(tr.ID) != 32 || strings.Trim(tr.ID, "0") == "" {
		t.Errorf("New() made %s, then %s", tr.ID, other.ID)
	}
}
