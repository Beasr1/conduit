package runner

import (
	"bytes"
	"encoding/json"
	"net/url"
	"slices"
	"strings"

	"github.com/Beasr1/conduit/server/internal/store"
	"github.com/Beasr1/conduit/server/internal/transform"
)

// A run's secret constants are masked wherever the run is kept or shown
// (plan 06): every exact copy of one, in a node's record, an event, the
// run's input, end and answer, or a log line, becomes its stand-in,
// [secret crm_token]. A copy an expression changed, cut or encoded, isn't
// found: masking is a net, not a boundary.

// short is the length under which a secret is masked only where a whole
// string is it: inside longer text, a short one would hide what isn't it.
const short = 8

type masker struct {
	secrets []hidden // longest first, so a secret inside another is the longer's
}

type hidden struct {
	value   string
	standIn string
	texts   []string // value, and as a query and a path escape it
	jsons   [][]byte // each of texts as JSON writes it inside a string, HTML-escaped and not
	whole   [][]byte // value alone as a JSON string, quotes and all, each way
}

func newMasker(cs []store.Constant) masker {
	var m masker
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
		for _, t := range []string{c.Value, url.QueryEscape(c.Value), url.PathEscape(c.Value)} {
			if slices.Contains(s.texts, t) {
				continue
			}
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

// text masks s, words or a URL.
func (m masker) text(s string) string {
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
	return s
}

// json masks doc, JSON, inside its strings: a short secret only as a whole
// string.
func (m masker) json(doc []byte) []byte {
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
