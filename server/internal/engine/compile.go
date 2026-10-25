// Package engine runs workflows.
//
// Compile turns a definition into a Program: package workflow checks its
// structure, and every expression is compiled through package transform.
// Run executes a Program. One scheduler goroutine owns the run's state and
// starts each node on a goroutine of its own once its parents have finished,
// so independent branches run in parallel. Node goroutines report back on a
// channel; nothing else touches the state, so it needs no lock.
package engine

import (
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/Beasr1/conduit/server/internal/transform"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// Program is a checked and compiled workflow. It can be run any number of
// times, concurrently.
type Program struct {
	nodes  []node
	edges  []edge
	output *transform.Expr // nil when the definition has none
}

type node struct {
	id   string
	kind workflow.NodeKind

	// http nodes
	method     string
	url        *transform.Template
	headers    []param         // sorted by name
	query      []param         // sorted by name
	body       *transform.Expr // nil: no body
	timeout    time.Duration   // zero: the client's default
	attempts   int
	idempotent bool

	// transform nodes
	expr *transform.Expr

	in        []int // edges into this node
	out       []int // edges out of it
	ancestors []int // every node upstream of it, in declaration order
}

type param struct {
	name  string
	value *transform.Template
}

type edge struct {
	from, to int
	when     *transform.Condition // nil: always taken
}

// Compile checks d and compiles every expression in it. The error, when
// there is one, is a workflow.Problems listing everything wrong.
func Compile(d *workflow.Definition) (*Program, error) {
	c := compiler{problems: workflow.Validate(d)}
	p := &Program{nodes: make([]node, len(d.Nodes)), edges: make([]edge, len(d.Edges))}

	for i, n := range d.Nodes {
		ptr := fmt.Sprintf("/nodes/%d", i)
		pn := &p.nodes[i]
		pn.id, pn.kind = n.ID, n.Kind
		switch {
		case n.Kind == workflow.NodeKindHTTP && n.Request != nil:
			r := n.Request
			pn.method = string(r.Method)
			pn.url = c.template(ptr+"/request/url", r.URL)
			pn.headers = c.params(ptr+"/request/headers", r.Headers)
			pn.query = c.params(ptr+"/request/query", r.Query)
			if r.Body != "" {
				pn.body = c.expr(ptr+"/request/body", r.Body)
			}
			pn.timeout = time.Duration(r.TimeoutMs) * time.Millisecond
			if r.Retry != nil {
				pn.attempts, pn.idempotent = r.Retry.Attempts, r.Retry.Idempotent
			}
		case n.Kind == workflow.NodeKindTransform && n.Expr != "":
			pn.expr = c.expr(ptr+"/expr", n.Expr)
		}
	}
	for k, e := range d.Edges {
		if e.When != "" {
			when, err := transform.CompileCondition(e.When)
			c.check(fmt.Sprintf("/edges/%d/when", k), err)
			p.edges[k].when = when
		}
	}
	if d.Output != "" {
		p.output = c.expr("/output", d.Output)
	}
	if len(c.problems) > 0 {
		return nil, c.problems
	}

	index := make(map[string]int, len(d.Nodes))
	for i, n := range d.Nodes {
		index[n.ID] = i
	}
	for k, e := range d.Edges {
		from, to := index[e.From], index[e.To]
		p.edges[k].from, p.edges[k].to = from, to
		p.nodes[from].out = append(p.nodes[from].out, k)
		p.nodes[to].in = append(p.nodes[to].in, k)
	}
	for i := range p.nodes {
		p.nodes[i].ancestors = p.ancestors(i)
	}
	return p, nil
}

// ancestors walks up from node i. Validation has ruled out cycles.
func (p *Program) ancestors(i int) []int {
	seen := make([]bool, len(p.nodes))
	stack := []int{i}
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, k := range p.nodes[n].in {
			if from := p.edges[k].from; !seen[from] {
				seen[from] = true
				stack = append(stack, from)
			}
		}
	}
	var out []int
	for a, ok := range seen {
		if ok {
			out = append(out, a)
		}
	}
	return out
}

type compiler struct {
	problems workflow.Problems
}

func (c *compiler) check(pointer string, err error) {
	if err != nil {
		c.problems = append(c.problems, workflow.Problem{Pointer: pointer, Code: "invalid_expression", Detail: err.Error()})
	}
}

func (c *compiler) expr(pointer, src string) *transform.Expr {
	x, err := transform.Compile(src)
	c.check(pointer, err)
	return x
}

func (c *compiler) template(pointer, src string) *transform.Template {
	t, err := transform.CompileTemplate(src)
	c.check(pointer, err)
	return t
}

func (c *compiler) params(pointer string, m map[string]string) []param {
	var out []param
	for _, name := range slices.Sorted(maps.Keys(m)) {
		out = append(out, param{name: name, value: c.template(pointer+"/"+escapeToken(name), m[name])})
	}
	return out
}

// escapeToken makes s one JSON Pointer reference token (RFC 6901 §3).
func escapeToken(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "~", "~0"), "/", "~1")
}
