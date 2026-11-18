package runner

import (
	"context"
	"slices"

	"github.com/Beasr1/conduit/server/internal/engine"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// marks is where a run meets values marked to be masked (plan 17): its
// input's fields, as its revision marks them, and, for each node that uses
// an upstream, the parameters and response fields the upstream's newest
// version marks, whichever version the node pins. A pin keeps a call and
// its answers as they were; a mark changes neither, only what's kept.
type marks struct {
	input []mark
	nodes map[string]nodeMarks
}

type mark struct {
	path []string
	mask workflow.Mask
}

type nodeMarks struct {
	params map[string]workflow.Mask
	fields []mark
}

// marksOf is the marks of a run of d, given the newest version of each
// upstream its nodes use, by id. A field that doesn't parse, which a save
// refuses, marks nothing.
func marksOf(d *workflow.Definition, newest map[string]*workflow.Upstream) marks {
	ms := marks{input: fieldMarks(d.MaskedInput), nodes: map[string]nodeMarks{}}
	for _, n := range d.Nodes {
		u := newest[upstreamOf(n)]
		if u == nil {
			continue
		}
		nm := nodeMarks{params: map[string]workflow.Mask{}, fields: fieldMarks(u.Masked)}
		for _, p := range u.Parameters {
			if p.Mask != nil {
				nm.params[p.Name] = *p.Mask
			}
		}
		ms.nodes[n.ID] = nm
	}
	return ms
}

// upstreamOf is the id of the upstream node n uses; empty if it uses none.
func upstreamOf(n workflow.Node) string {
	if n.Uses == nil {
		return ""
	}
	return n.Uses.Upstream
}

// upstreamsOf is the ids of the upstreams d's nodes use.
func upstreamsOf(d *workflow.Definition) []string {
	var ids []string
	for _, n := range d.Nodes {
		if id := upstreamOf(n); id != "" && !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	return ids
}

type maskerKey struct{}

// withMasker is ctx with run's masker, which a run of a workflow a step of
// it uses hands what it masks.
func withMasker(ctx context.Context, m *masker) context.Context {
	return context.WithValue(ctx, maskerKey{}, m)
}

// maskerFrom is the masker of the run ctx is a step's of; nil outside one.
func maskerFrom(ctx context.Context) *masker {
	m, _ := ctx.Value(maskerKey{}).(*masker)
	return m
}

func fieldMarks(fs []workflow.MaskedField) []mark {
	var out []mark
	for _, f := range fs {
		if path, err := workflow.FieldPath(f.Field); err == nil {
			out = append(out, mark{path: path, mask: f.Mask})
		}
	}
	return out
}

// ofInput marks, in m, the values the run's input has where it's marked.
func (ms marks) ofInput(m *masker, input []byte) {
	if len(ms.input) == 0 {
		return
	}
	v := decodeDoc(input)
	for _, mk := range ms.input {
		m.add(mk.mask, valuesAt(v, mk.path)...)
	}
}

// ofNode marks, in m, what node res gave a marked parameter, and what its
// response, at any status, has in a marked field.
func (ms marks) ofNode(m *masker, res engine.NodeResult) {
	nm, ok := ms.nodes[res.ID]
	if !ok {
		return
	}
	if res.Request != nil && len(nm.params) > 0 {
		given := decodeDoc(res.Request.Params)
		for name, mask := range nm.params {
			m.add(mask, valuesAt(given, []string{name})...)
		}
	}
	if res.Body != nil && len(nm.fields) > 0 {
		body := decodeDoc(res.Body)
		for _, mk := range nm.fields {
			m.add(mk.mask, valuesAt(body, mk.path)...)
		}
	}
}
