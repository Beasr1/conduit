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
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/Beasr1/conduit/server/internal/transform"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// Program is a checked and compiled workflow. It can be run any number of
// times, concurrently.
type Program struct {
	nodes    []node
	edges    []edge
	response *response          // nil when the definition has none
	output   *transform.Expr    // nil when the definition has none
	input    *jsonschema.Schema // nil when the definition has no input_schema
}

// response is where a run's answer comes from: the answers, each a status
// and the lines into it, tried top to bottom; the statuses each node that
// picks among answers picks from; and the error body, for a run that gives
// none and an answer passed an error straight through.
type response struct {
	answers []answer        // in the definition's order, which a run tries them in
	picks   map[int][]int   // a transform with an expr joined to several answers: their statuses
	errors  *transform.Expr // nil when there's none
}

// answer is a status, and the lines into it, in the definition's order.
type answer struct {
	status int
	lines  []answerLine
}

// answerLine is a line into an answer, reached when node from answers
// through output on: a status, 0 for 2xx and for a transform's one output,
// or workflow.OnUnhandled.
type answerLine struct {
	from, on int
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
	outputs    []int // the statuses besides 2xx it answers with
	// bound says it uses an upstream or a workflow (plan 07): its request
	// reads the values with gives its parameters, not the run, or the
	// workflow takes them as its input. calls is the workflow, at its
	// revision; nil for an upstream's or a request of its own.
	bound bool
	with  []binding // sorted by name
	calls *workflow.Uses

	// catches says a line leaves its Unhandled block, which then takes its
	// failures. unhandled is the block's body; nil: it gives what it got.
	catches   bool
	unhandled *transform.Expr

	// transform nodes: an expr, or a switch's cases, never nil for one with
	// a switch. whole says every expression in it compiled.
	expr  *transform.Expr
	cases []switchCase
	whole bool

	in        []int // edges into this node
	out       []int // edges out of it
	ancestors []int // every node it runs after, directly or not, in declaration order
}

type param struct {
	name  string
	value *transform.Template
}

// binding is a parameter of an upstream a node uses, and the expression
// that gives it a value.
type binding struct {
	name  string
	value *transform.Expr
}

// switchCase is one of a switch's cases.
type switchCase struct {
	when   *transform.Condition
	status int
	body   *transform.Expr // nil: no body
}

type edge struct {
	from, to int
	on       int                  // the output of from it leaves from: a status, 0 for 2xx, or workflow.OnUnhandled
	when     *transform.Condition // nil: always taken
	required bool                 // into a transform, it has to be taken for the transform to run
}

// bindings compiles the expressions node ptr gives its parameters, by name.
func (c *compiler) bindings(ptr string, with map[string]string) []binding {
	var out []binding
	for _, name := range slices.Sorted(maps.Keys(with)) {
		out = append(out, binding{name: name, value: c.expr(ptr+"/with/"+workflow.PointerToken(name), with[name])})
	}
	return out
}

// Compile checks d and compiles every expression in it. The error, when
// there is one, is a workflow.Problems listing everything wrong.
func Compile(d *workflow.Definition) (*Program, error) {
	p, ps := build(d)
	if len(ps) > 0 {
		return nil, ps
	}
	return p, nil
}

// build compiles what it can of d and lists everything wrong with it. An
// expression that doesn't compile is left nil, and an edge is wired only
// when each end names another node, so the program is whole only when
// nothing is wrong. A preview reads what there is.
func build(d *workflow.Definition) (*Program, workflow.Problems) {
	c := compiler{problems: workflow.Validate(d)}
	p := &Program{nodes: make([]node, len(d.Nodes)), edges: make([]edge, len(d.Edges))}

	for i, n := range d.Nodes {
		ptr := fmt.Sprintf("/nodes/%d", i)
		pn := &p.nodes[i]
		pn.id, pn.kind = n.ID, n.Kind
		switch {
		case n.Kind == workflow.NodeKindHTTP && n.Uses != nil && n.Uses.Workflow != "":
			// It runs the workflow, which its answers besides 2xx are the
			// outputs of, as Resolve has them.
			pn.calls = &workflow.Uses{Workflow: n.Uses.Workflow, Revision: n.Uses.Revision}
			for _, o := range n.Outputs {
				pn.outputs = append(pn.outputs, o.Status)
			}
			pn.bound, pn.with = true, c.bindings(ptr, n.With)
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
			for _, o := range n.Outputs {
				pn.outputs = append(pn.outputs, o.Status)
			}
			if n.Uses != nil {
				pn.bound, pn.with = true, c.bindings(ptr, n.With)
			}
		case n.Kind == workflow.NodeKindTransform && n.Switch != nil:
			pn.cases, pn.whole = c.cases(ptr+"/switch", n.Switch)
		case n.Kind == workflow.NodeKindTransform && n.Expr != "":
			pn.expr = c.expr(ptr+"/expr", n.Expr)
			pn.whole = pn.expr != nil
		}
		if n.Unhandled != nil && n.Unhandled.Body != "" {
			pn.unhandled = c.expr(ptr+"/unhandled/body", n.Unhandled.Body)
		}
	}
	for k, e := range d.Edges {
		p.edges[k].on, p.edges[k].required = e.Output(), e.Required
		if e.When != "" {
			when, err := transform.CompileCondition(e.When)
			c.check(fmt.Sprintf("/edges/%d/when", k), err)
			p.edges[k].when = when
		}
	}
	if d.Output != "" {
		p.output = c.expr("/output", d.Output)
	}
	if len(d.InputSchema) > 0 {
		p.input = c.jsonSchema("/input_schema", d.InputSchema)
	}
	if len(d.OutputSchema) > 0 {
		c.jsonSchema("/output_schema", d.OutputSchema)
	}

	// A repeated id is its first node's, as validation reads it.
	index := make(map[string]int, len(d.Nodes))
	for i, n := range d.Nodes {
		if _, taken := index[n.ID]; !taken {
			index[n.ID] = i
		}
	}
	for k, e := range d.Edges {
		from, okFrom := index[e.From]
		to, okTo := index[e.To]
		if !okFrom || !okTo || from == to {
			continue
		}
		p.edges[k].from, p.edges[k].to = from, to
		p.nodes[from].out = append(p.nodes[from].out, k)
		p.nodes[to].in = append(p.nodes[to].in, k)
		if e.Unhandled {
			p.nodes[from].catches = true
		}
	}
	if r := d.Response; r != nil {
		p.response = &response{picks: map[int][]int{}}
		// A from that names no node is a problem, so such a program never runs.
		for k, a := range r.Answers {
			ans := answer{status: a.Status}
			for _, l := range a.Lines {
				from, ok := index[l.From]
				ans.lines = append(ans.lines, answerLine{from: from, on: l.Output()})
				if ok && l.Unhandled {
					p.nodes[from].catches = true
				}
				if ok && !l.Unhandled && d.Nodes[from].Kind == workflow.NodeKindTransform && d.Nodes[from].Switch == nil {
					p.response.picks[from] = append(p.response.picks[from], a.Status)
				}
			}
			p.response.answers = append(p.response.answers, ans)
			if len(a.Schema) > 0 {
				c.jsonSchema(fmt.Sprintf("/response/answers/%d/schema", k), a.Schema)
			}
		}
		if r.Errors != nil && r.Errors.Body != "" {
			p.response.errors = c.expr("/response/errors/body", r.Errors.Body)
		}
	}
	for i := range p.nodes {
		p.nodes[i].ancestors = p.ancestors(i)
	}
	return p, c.problems
}

// ancestors walks up from node i. Validation rules out cycles in a program
// that runs; on one that doesn't, a node can be among its own, and a
// preview leaves out every node on or after a cycle.
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

// cases compiles a switch: its cases, and whether every
// expression in them compiled.
func (c *compiler) cases(pointer string, s *workflow.Switch) ([]switchCase, bool) {
	whole := true
	body := func(ptr, src string) *transform.Expr {
		if src == "" {
			return nil
		}
		x := c.expr(ptr+"/body", src)
		whole = whole && x != nil
		return x
	}
	out := make([]switchCase, len(s.Cases))
	for k, sc := range s.Cases {
		ptr := fmt.Sprintf("%s/cases/%d", pointer, k)
		var when *transform.Condition
		if sc.When != "" { // a missing condition is validation's problem
			var err error
			when, err = transform.CompileCondition(sc.When)
			c.check(ptr+"/when", err)
		}
		whole = whole && when != nil
		out[k] = switchCase{when: when, status: sc.Status, body: body(ptr, sc.Body)}
	}
	return out, whole
}

func (c *compiler) template(pointer, src string) *transform.Template {
	t, err := transform.CompileTemplate(src)
	c.check(pointer, err)
	return t
}

func (c *compiler) params(pointer string, m map[string]string) []param {
	var out []param
	for _, name := range slices.Sorted(maps.Keys(m)) {
		out = append(out, param{name: name, value: c.template(pointer+"/"+workflow.PointerToken(name), m[name])})
	}
	return out
}

// jsonSchema checks that doc compiles as JSON Schema 2020-12. Its $refs can
// only point inside it. The library's default loader reads local files, and
// a schema someone typed mustn't make the server read anything.
func (c *compiler) jsonSchema(pointer string, doc map[string]any) *jsonschema.Schema {
	jc := jsonschema.NewCompiler()
	jc.UseLoader(nil)
	jc.DefaultDraft(jsonschema.Draft2020)
	// A made-up absolute base, so messages carry no local path and a relative
	// $ref resolves to a URL nothing will load.
	const loc = "https://conduit.invalid/schema.json"
	var sch *jsonschema.Schema
	err := jc.AddResource(loc, doc)
	if err == nil {
		sch, err = jc.Compile(loc)
	}
	if err != nil {
		c.problems = append(c.problems, workflow.Problem{Pointer: pointer, Code: "invalid_schema", Detail: err.Error()})
	}
	return sch
}

// CheckInput reports how input, raw JSON, fails the definition's
// input_schema: one problem per failing value, each pointing into the input.
// A definition without an input_schema takes any JSON.
func (p *Program) CheckInput(input json.RawMessage) []workflow.Problem {
	if p.input == nil {
		return nil
	}
	// The library's own decoder keeps numbers exact.
	v, err := jsonschema.UnmarshalJSON(bytes.NewReader(input))
	if err != nil {
		return []workflow.Problem{{Pointer: "", Code: "invalid_json", Detail: "the input isn't JSON"}}
	}
	var ve *jsonschema.ValidationError
	if !errors.As(p.input.Validate(v), &ve) {
		return nil
	}
	var out []workflow.Problem
	for _, u := range ve.BasicOutput().Errors {
		if u.Error != nil {
			out = append(out, workflow.Problem{Pointer: u.InstanceLocation, Code: "invalid_input", Detail: u.Error.String()})
		}
	}
	return out
}

// NodeCount is how many nodes p has, so how many events end a node in a run.
func (p *Program) NodeCount() int { return len(p.nodes) }
