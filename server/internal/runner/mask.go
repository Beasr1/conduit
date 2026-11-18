package runner

import (
	"bytes"
	"encoding/json"
	"maps"
	"net/url"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/transform"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// A run's secret constants are masked wherever the run is kept or shown
// (plan 06): every exact copy of one, in a node's record, an event, the
// run's input, end and answer, or a log line, becomes its stand-in,
// [secret crm_token]. A copy an expression changed, cut or encoded, isn't
// found: masking is a net, not a boundary.
//
// A marked value (plan 17), met as the run goes, is masked the same way in
// what the run keeps, as stars, but not in what it answers: the caller gets
// it as it is.

// short is the length under which a secret or a marked value is masked
// only where a whole string is it: inside longer text, a short one would
// hide what isn't it.
const short = 8

type masker struct {
	secrets []hidden // longest first, so a secret inside another is the longer's

	mu sync.Mutex
	// marked is the marked values met so far, longest first. add replaces
	// it, never changes it, so what a reader took stays as it was.
	marked []shown
}

type hidden struct {
	value   string
	standIn string
	texts   []string // value, and as a query and a path escape it
	jsons   [][]byte // each of texts as JSON writes it inside a string, HTML-escaped and not
	whole   [][]byte // value alone as a JSON string, quotes and all, each way
}

// shown is a marked value: a string, or a number as JSON writes it.
type shown struct {
	value   string
	standIn string   // its stars
	kept    int      // the characters its stars keep
	texts   []string // value, and as a query and a path escape it
	short   bool
}

func newMasker(cs []store.Constant) *masker {
	m := &masker{}
	for _, c := range cs {
		if !c.Secret || c.Value == "" {
			continue
		}
		s := hidden{value: c.Value, standIn: transform.StandIn(c.Name)}
		for _, html := range []bool{true, false} {
			if j := quoted(c.Value, html); !slices.ContainsFunc(s.whole, func(k []byte) bool { return bytes.Equal(j, k) }) {
				s.whole = append(s.whole, j)
			}
		}
		for _, t := range escapes(c.Value) {
			s.texts = append(s.texts, t)
			for _, j := range [][]byte{inJSON(t, true), inJSON(t, false)} {
				if !slices.ContainsFunc(s.jsons, func(k []byte) bool { return bytes.Equal(j, k) }) {
					s.jsons = append(s.jsons, j)
				}
			}
		}
		m.secrets = append(m.secrets, s)
	}
	slices.SortFunc(m.secrets, func(a, b hidden) int { return len(b.value) - len(a.value) })
	return m
}

// escapes is v, and as a query and a path escape it, each once.
func escapes(v string) []string {
	var out []string
	for _, t := range []string{v, url.QueryEscape(v), url.PathEscape(v)} {
		if !slices.Contains(out, t) {
			out = append(out, t)
		}
	}
	return out
}

// quoted is s as JSON writes it, a string, quotes and all.
func quoted(s string, escapeHTML bool) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(escapeHTML)
	_ = enc.Encode(s) // a string always encodes
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}

// inJSON is s as JSON writes it inside a string: its quotes trimmed.
func inJSON(s string, escapeHTML bool) []byte {
	q := quoted(s, escapeHTML)
	return q[1 : len(q)-1]
}

// ends is how many characters mask keeps at the start and at the end of a
// value of n: at least half is always hidden, rounded up, so a mask that
// would show more shows less, its start giving way first, since the end is
// what tells records apart.
func ends(n int, mask workflow.Mask) (start, end int) {
	most := n / 2
	end = min(mask.End, most)
	return min(mask.Start, most-end), end
}

// stars is value as mask keeps it: a star for each character hidden.
func stars(value string, mask workflow.Mask) string {
	rs := []rune(value)
	start, end := ends(len(rs), mask)
	return string(rs[:start]) + strings.Repeat("*", len(rs)-start-end) + string(rs[len(rs)-end:])
}

// add marks values, each kept as mask keeps it, from now on.
func (m *masker) add(mask workflow.Mask, values ...string) {
	ss := make([]shown, len(values))
	for i, v := range values {
		n := utf8.RuneCountInString(v)
		start, end := ends(n, mask)
		ss[i] = shown{value: v, standIn: stars(v, mask), kept: start + end, texts: escapes(v), short: n < short}
	}
	m.put(ss...)
}

// adopt marks what o has marked: a run of a workflow a step uses hands its
// caller's run what it met (plan 17).
func (m *masker) adopt(o *masker) { m.put(o.now()...) }

// put marks ss. A value marked already keeps whichever stars keep fewer
// characters.
func (m *masker) put(ss ...shown) {
	m.mu.Lock()
	defer m.mu.Unlock()
	marked := slices.Clone(m.marked)
	for _, s := range ss {
		switch i := slices.IndexFunc(marked, func(o shown) bool { return o.value == s.value }); {
		case i < 0:
			marked = append(marked, s)
		case s.kept < marked[i].kept:
			marked[i] = s
		}
	}
	slices.SortStableFunc(marked, func(a, b shown) int { return len(b.value) - len(a.value) })
	m.marked = marked
}

// now is the marked values met so far.
func (m *masker) now() []shown {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.marked
}

// count is how many marked values the run has met.
func (m *masker) count() int { return len(m.now()) }

// text masks s, words or a URL: its secrets and its marked values.
func (m *masker) text(s string) string {
	for _, sc := range m.secrets {
		if len(sc.value) < short {
			if s == sc.value {
				return sc.standIn
			}
			continue
		}
		for _, t := range sc.texts {
			s = strings.ReplaceAll(s, t, sc.standIn)
		}
	}
	return markedText(s, m.now())
}

// answer masks doc, JSON a run answers, its secrets only: the caller gets
// a marked value as it is (plan 17).
func (m *masker) answer(doc []byte) []byte {
	if len(m.secrets) == 0 || doc == nil {
		return doc
	}
	for _, sc := range m.secrets {
		if len(sc.value) < short {
			for _, w := range sc.whole {
				doc = bytes.ReplaceAll(doc, w, quoted(sc.standIn, true))
			}
			continue
		}
		for _, j := range sc.jsons {
			doc = bytes.ReplaceAll(doc, j, inJSON(sc.standIn, true))
		}
	}
	return doc
}

// json masks doc, JSON a run keeps: its secrets inside its strings, a
// short one only as a whole string; then its marked values, from its
// decoded strings and numbers, so however it escapes them. jsonb keeps no
// key order, so writing it afresh loses nothing; doc that isn't JSON is
// left as it is.
func (m *masker) json(doc []byte) []byte {
	doc = m.answer(doc)
	marked := m.now()
	if len(marked) == 0 || doc == nil {
		return doc
	}
	v := decodeDoc(doc)
	if v == nil {
		return doc
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(markedValue(v, marked)); err != nil {
		return doc
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}

// decodeDoc is doc decoded, numbers as written; nil for null, or for what
// isn't JSON.
func decodeDoc(doc []byte) any {
	dec := json.NewDecoder(bytes.NewReader(doc))
	dec.UseNumber()
	var v any
	if dec.Decode(&v) != nil {
		return nil
	}
	return v
}

// markedValue masks v, decoded JSON, in place: its strings, and each
// number that is a marked value, which is kept as a string of its stars.
func markedValue(v any, marked []shown) any {
	switch x := v.(type) {
	case string:
		return markedText(x, marked)
	case json.Number:
		if i := slices.IndexFunc(marked, func(s shown) bool { return s.value == x.String() }); i >= 0 {
			return marked[i].standIn
		}
	case []any:
		for i, e := range x {
			x[i] = markedValue(e, marked)
		}
	case map[string]any:
		for k, e := range x {
			x[k] = markedValue(e, marked)
		}
	}
	return v
}

// markedText masks the marked values in s: a short one only where it's all
// of s.
func markedText(s string, marked []shown) string {
	for _, sh := range marked {
		if sh.short {
			if s == sh.value {
				return sh.standIn
			}
			continue
		}
		for _, t := range sh.texts {
			s = strings.ReplaceAll(s, t, sh.standIn)
		}
	}
	return s
}

// valuesAt is what a field path names in v, decoded JSON, as an expression
// reads it: over each item of an array, and every string and number inside
// what holds more. An empty string, a boolean or null holds nothing to mask.
func valuesAt(v any, path []string) []string {
	at := []any{v}
	for _, name := range path {
		var next []any
		for _, e := range at {
			next = append(next, children(e, name)...)
		}
		at = next
	}
	var out []string
	for _, e := range at {
		out = leaves(out, e)
	}
	return out
}

// children is what name gives in v: an object's field, or each item's of
// an array, as JSONata maps over one.
func children(v any, name string) []any {
	switch x := v.(type) {
	case map[string]any:
		if c, ok := x[name]; ok {
			return []any{c}
		}
	case []any:
		var out []any
		for _, e := range x {
			out = append(out, children(e, name)...)
		}
		return out
	}
	return nil
}

// leaves adds the strings and numbers in v to out, an object's in the
// order of its keys.
func leaves(out []string, v any) []string {
	switch x := v.(type) {
	case string:
		if x != "" {
			out = append(out, x)
		}
	case json.Number:
		out = append(out, x.String())
	case []any:
		for _, e := range x {
			out = leaves(out, e)
		}
	case map[string]any:
		for _, k := range slices.Sorted(maps.Keys(x)) {
			out = leaves(out, x[k])
		}
	}
	return out
}
