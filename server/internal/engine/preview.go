package engine

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"

	"github.com/Beasr1/conduit/server/internal/trace"
	"github.com/Beasr1/conduit/server/internal/upstream"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// UnhandledPreview is what a step's Unhandled body reads and gives in a
// preview.
type UnhandledPreview struct {
	Reads json.RawMessage
	Gives json.RawMessage
}

// ErrNoSuchNode is a preview of a step the definition doesn't have.
var ErrNoSuchNode = errors.New("no step has that id")

// ErrNoSuchEdge is a preview of a connection the definition doesn't have.
var ErrNoSuchEdge = errors.New("no connection is at that place")

// Preview is what a step would read and do in a run, or whether a run would
// take a connection, simulated over the definition's samples.
type Preview struct {
	// Reads is the data document the step, or a connection's condition,
	// reads, as a run builds it.
	Reads json.RawMessage
	// Sends is an http step's request: every part of it that rendered.
	Sends *SentRequest
	// Parameters is an http step that uses an upstream: the values its
	// parameters take, by name, which its request reads. One whose value
	// fails is left out, as Problems says.
	Parameters json.RawMessage
	// Gives is a transform step's value, or the workflow's output.
	Gives json.RawMessage
	// Ways is a transform step with two or more connections into it: what
	// it gives in a run by each, in the definition's order. Reads is then
	// what those runs read, merged, and Gives is nil.
	Ways []WayPreview
	// Taken says whether a run would take the connection previewed. It's
	// nil for a step, and when the preview can't tell, as its problems say.
	Taken *bool
	// Skipped says a run would skip the step, or the connection's source:
	// no connection into it is taken.
	Skipped bool
	// Unhandled is a step with an Unhandled body failing into its block, an
	// error made up: what the body reads, and what it gives.
	Unhandled *UnhandledPreview
	// Outcomes is, for a step or a connection's source, what each step
	// before it may have done in a run that reaches it, by id, from the
	// edges whatever the samples; nil when it never runs.
	Outcomes map[string]workflow.Outcome
	// Problems is what kept a part from rendering, each sample missing on
	// the way, and what's wrong with the definition there, by pointer.
	Problems workflow.Problems
}

// WayPreview is what a transform gives in a run that comes by one
// connection into it.
type WayPreview struct {
	// Edge is the connection, by its place in the definition's edges.
	Edge int
	// Gives is the transform's value in that run.
	Gives json.RawMessage
	// Skipped says no run comes by the connection: that run doesn't take it,
	// or skips the transform, as a required one isn't taken.
	Skipped bool
}

// Simulate previews step id, or the workflow's output when id is "", over
// d's samples, and calls nothing. Each http step before it answers with the
// sample of an output that leads to it, 2xx when that does, and each
// transform before it is evaluated, and so is each connection's condition,
// as a run would. A step only whose Unhandled block leads to it fails, with
// an error made up. Previewing the output, every http step answers 2xx. The
// required connections into each transform it runs come, the steps before
// them answering through the outputs that lead to them, and a transform
// with two or more connections is previewed in a run by each, its required
// ones coming first.
// It works on a definition with problems, compiling what it can and
// reporting what's in the way.
//
// A node that uses a workflow answers as the workflow's own preview has it
// answer (plan 07): deps holds the revisions nodes use, as saved, and their
// own, and d is resolved from them.
func Simulate(ctx context.Context, d *workflow.Definition, id string, deps workflow.Deps) (pv *Preview, err error) {
	defer catch(&pv, &err)
	target := -1
	if id != "" {
		if target = slices.IndexFunc(d.Nodes, func(n workflow.Node) bool { return n.ID == id }); target < 0 {
			return nil, ErrNoSuchNode
		}
	}
	p, problems := build(d)
	if ways := p.ways(target); len(ways) > 1 {
		pv = simulateWays(ctx, p, d, target, problems, ways, deps)
	} else {
		s := simOf(ctx, p, d, deps)
		var runs bool
		pv, runs = s.simulate(target, problems)
		if runs && target >= 0 && p.nodes[target].unhandled != nil {
			s.unhandled(pv, target)
		}
		pv.Problems = s.problems
	}
	pv.Outcomes = outcomesOf(d, target)
	return pv, nil
}

// outcomesOf is workflow.Outcomes of node i, by the nodes' ids; nil for the
// output, i -1.
func outcomesOf(d *workflow.Definition, i int) map[string]workflow.Outcome {
	out := workflow.Outcomes(d, i)
	if out == nil {
		return nil
	}
	byID := make(map[string]workflow.Outcome, len(out))
	for x, o := range out {
		byID[d.Nodes[x].ID] = o
	}
	return byID
}

// simulateWays previews transform t by each of ways, the connections into
// it: a run that comes by the required ones, and then by it where they let
// it, gives a value, unless it surely doesn't take that connection. What t
// reads is what those runs read, merged, a step read differently by two as
// the first read it, and its Unhandled body reads that. A problem two runs
// have is listed once.
func simulateWays(ctx context.Context, p *Program, d *workflow.Definition, t int, problems workflow.Problems, ways []int, deps workflow.Deps) *Preview {
	pv := &Preview{Skipped: true}
	merged := simOf(ctx, p, d, deps)
	ran := false
	for _, k := range ways {
		s := simOf(ctx, p, d, deps)
		way, runs := s.simulate(t, problems, k)
		if way.Skipped || !s.might(k) {
			pv.Ways = append(pv.Ways, WayPreview{Edge: k, Skipped: true})
		} else {
			pv.Ways = append(pv.Ways, WayPreview{Edge: k, Gives: way.Gives})
		}
		pv.Skipped = pv.Skipped && way.Skipped
		ran = ran || runs
		for i, e := range s.entry {
			if merged.entry[i] == nil {
				merged.entry[i] = e
			}
		}
		for _, pr := range s.problems {
			if !slices.Contains(merged.problems, pr) {
				merged.problems = append(merged.problems, pr)
			}
		}
	}
	var err error
	if pv.Reads, err = document(merged.input, merged.parts(t)); err != nil {
		merged.problem("/nodes/"+strconv.Itoa(t), "evaluation_failed", "%v", err)
	} else if ran && p.nodes[t].unhandled != nil {
		merged.unhandled(pv, t)
	}
	pv.Problems = merged.problems
	return pv
}

// ways is the connections into node t, in the definition's order; nil but
// for a transform.
func (p *Program) ways(t int) []int {
	if t < 0 || p.nodes[t].kind != workflow.NodeKindTransform {
		return nil
	}
	return p.nodes[t].in
}

// simulate previews node target, or the output when it's -1, in a run that
// comes by the edges by into it: what it reads, and what it sends or gives.
// runs says whether the run starts target.
func (s *sim) simulate(target int, problems workflow.Problems, by ...int) (pv *Preview, runs bool) {
	s.aim(target, problems, by...)
	pv = &Preview{}
	switch {
	case !s.runs(target):
		// On or after a loop of connections: nothing runs it. Validation
		// reports the loop.
		pv.Reads, _ = document(s.input, nil)
		return pv, false
	case target < 0:
		s.output(pv)
		return pv, true
	default:
		return pv, s.step(pv, target)
	}
}

// SimulateEdge previews the connection at place k in d's edges: what its
// condition reads, with its source answering through the connection's
// output, and whether a run would take it. The steps before the source are
// simulated as for a preview of the source.
func SimulateEdge(ctx context.Context, d *workflow.Definition, k int, deps workflow.Deps) (pv *Preview, err error) {
	defer catch(&pv, &err)
	if k < 0 || k >= len(d.Edges) {
		return nil, ErrNoSuchEdge
	}
	s, problems := newSim(ctx, d, deps)
	s.edge = k
	e := s.p.edges[k]
	pv = &Preview{}
	if e.from == e.to {
		// It's wired only when each end names another node; its problems
		// say why not.
		s.keep(problems)
		pv.Reads, _ = document(s.input, nil)
		pv.Problems = s.problems
		return pv, nil
	}
	src := e.from
	pv.Outcomes = outcomesOf(d, src)
	s.aim(src, problems)
	s.via[src] = e.on
	if !s.runs(src) {
		pv.Reads, _ = document(s.input, nil)
		pv.Problems = s.problems
		return pv, nil
	}
	s.run(src)
	pv.Skipped = s.skipped[src]
	parts := s.parts(src)
	if s.entry[src] != nil {
		parts = append(parts, docPart{id: s.p.nodes[src].id, entry: s.entry[src]})
	}
	if pv.Reads, err = document(s.input, parts); err != nil {
		s.problem("/edges/"+strconv.Itoa(k), "evaluation_failed", "%v", err)
		pv.Problems = s.problems
		return pv, nil
	}
	switch {
	case pv.Skipped:
		pv.Taken = new(bool)
	case s.entry[src] == nil:
		// The source didn't answer, and its problem says why.
	case d.Edges[k].When == "":
		taken := true
		pv.Taken = &taken
	case e.when == nil:
		// The condition doesn't compile, and its problem says so.
	default:
		taken, err := e.when.Eval(s.ctx, pv.Reads)
		if err != nil {
			s.problem("/edges/"+strconv.Itoa(k)+"/when", "evaluation_failed", "%v", err)
			break
		}
		pv.Taken = &taken
	}
	pv.Problems = s.problems
	return pv, nil
}

// unnamed is an error give gave, without the field it names: a preview's
// problem points at that field instead.
func unnamed(err error) error {
	if inner := errors.Unwrap(err); inner != nil {
		return inner
	}
	return err
}

// catch turns a panic in a preview into its error.
func catch(pv **Preview, err *error) {
	if v := recover(); v != nil {
		*pv, *err = nil, &PanicError{Value: v, Stack: debug.Stack()}
	}
}

// sim is one preview's state: what each node gave, as far as it can tell.
type sim struct {
	ctx      context.Context
	p        *Program
	d        *workflow.Definition
	input    json.RawMessage
	target   int               // the node previewed, a connection's source, or -1 for the output
	edge     int               // the connection previewed, or -1
	entry    []json.RawMessage // a node's part of the data document, once it ran
	needed   []bool            // the nodes the preview runs
	via      []int             // the output each node answers through: a status, 0 for 2xx, or workflow.OnUnhandled
	skipped  []bool
	taken    []bool // by edge, once its source ran
	problems workflow.Problems
	// deps is the revisions the workflows nodes use, and depth how many
	// workflows deep this preview is (plan 07).
	deps  workflow.Deps
	depth int
}

// newSim compiles what it can of d for a preview, and lists everything wrong
// with it.
func newSim(ctx context.Context, d *workflow.Definition, deps workflow.Deps) (*sim, workflow.Problems) {
	p, problems := build(d)
	return simOf(ctx, p, d, deps), problems
}

// simOf is a preview's state at its start, over p, compiled from d.
func simOf(ctx context.Context, p *Program, d *workflow.Definition, deps workflow.Deps) *sim {
	input := d.SampleInput
	if len(input) == 0 {
		input = json.RawMessage("null")
	}
	return &sim{
		ctx:     ctx,
		p:       p,
		d:       d,
		input:   input,
		target:  -1,
		edge:    -1,
		entry:   make([]json.RawMessage, len(p.nodes)),
		needed:  make([]bool, len(p.nodes)),
		via:     make([]int, len(p.nodes)),
		skipped: make([]bool, len(p.nodes)),
		taken:   make([]bool, len(p.edges)),
		deps:    deps,
	}
}

func (s *sim) problem(pointer, code, format string, args ...any) {
	s.problems = append(s.problems, workflow.Problem{Pointer: pointer, Code: code, Detail: fmt.Sprintf(format, args...)})
}

// aim points the preview at target, a node, or the output when it's -1:
// the nodes it runs, the output each of them answers through, and the
// problems in its way. A node's preview comes by each required edge into a
// transform it runs, so the transform does, and then by the edges by into
// it, where the required ones leave the steps before free to.
func (s *sim) aim(target int, problems workflow.Problems, by ...int) {
	s.target = target
	s.needed = s.need(target)
	s.choose(target)
	if target >= 0 {
		s.steer(by, s.steer(s.required(), make([]bool, len(s.p.nodes))))
	}
	s.keep(problems)
}

// required is the required edges into the transforms the preview runs, in
// the definition's order.
func (s *sim) required() []int {
	var out []int
	for k, e := range s.p.edges {
		// An edge build didn't wire has both ends at 0.
		if e.required && e.from != e.to && s.needed[e.to] && s.p.nodes[e.to].kind == workflow.NodeKindTransform {
			out = append(out, k)
		}
	}
	return out
}

// need marks the nodes a preview of target runs: its ancestors and itself,
// or every node for the output.
func (s *sim) need(target int) []bool {
	need := make([]bool, len(s.p.nodes))
	if target < 0 {
		for i := range need {
			need[i] = true
		}
		return need
	}
	need[target] = true
	for _, a := range s.p.nodes[target].ancestors {
		need[a] = true
	}
	return need
}

// choose picks the output each needed node before target answers through,
// leading on towards target. Previewing the output, every node answers 2xx.
func (s *sim) choose(target int) {
	if target < 0 {
		return
	}
	for i := range s.p.nodes {
		if s.needed[i] && i != target {
			s.via[i] = s.lead(i, s.needed)
		}
	}
}

// steer has the preview come by the edges ks into its target: each edge's
// source answers through the edge's output, and each node before them
// through one leading on towards them, but for the nodes fixed, steered
// already, which keep their outputs. It gives back the nodes it steered
// towards.
func (s *sim) steer(ks []int, fixed []bool) []bool {
	toward := make([]bool, len(s.p.nodes))
	for _, k := range ks {
		for i, need := range s.need(s.p.edges[k].from) {
			toward[i] = toward[i] || need
		}
	}
	for i := range s.p.nodes {
		if toward[i] && !fixed[i] {
			s.via[i] = s.lead(i, toward)
		}
	}
	for _, k := range ks {
		if e := s.p.edges[k]; !fixed[e.from] {
			s.via[e.from] = e.on
		}
	}
	return toward
}

// lead is the output node i answers through to lead on towards the nodes
// toward marks: one with a connection to them, 2xx when that has one, else
// a status, else Unhandled, else 2xx.
func (s *sim) lead(i int, toward []bool) int {
	n := &s.p.nodes[i]
	leads := make(map[int]bool)
	for _, k := range n.out {
		if e := s.p.edges[k]; toward[e.to] {
			leads[e.on] = true
		}
	}
	if leads[0] {
		return 0
	}
	if j := slices.IndexFunc(n.outputs, func(status int) bool { return leads[status] }); j >= 0 {
		return n.outputs[j]
	}
	if leads[workflow.OnUnhandled] {
		return workflow.OnUnhandled
	}
	return 0
}

// keep adds the problems with the definition that are in the preview's way.
func (s *sim) keep(problems workflow.Problems) {
	for _, pr := range problems {
		if s.concerns(pr.Pointer) {
			s.problems = append(s.problems, pr)
		}
	}
}

// concerns says whether a problem with the definition is in the way of this
// preview: in a node it runs, an edge between two of them or the edge it
// previews, the sample input, or the output when that's what it previews.
func (s *sim) concerns(pointer string) bool {
	tokens := workflow.PointerTokens(pointer)
	if len(tokens) == 0 {
		return false
	}
	switch tokens[0] {
	case "sample_input":
		return true
	case "output":
		return s.target < 0 && s.edge < 0
	}
	if len(tokens) < 2 {
		return false
	}
	i, err := strconv.Atoi(tokens[1])
	if err != nil || i < 0 {
		return false
	}
	switch tokens[0] {
	case "nodes":
		return i < len(s.needed) && s.needed[i]
	case "edges":
		if i == s.edge {
			return true
		}
		if i >= len(s.p.edges) {
			return false
		}
		// An edge build didn't wire, as an end names no node, has both ends
		// at 0; a wired one never does, as a node's edge to itself isn't.
		e := s.p.edges[i]
		return e.from != e.to && s.needed[e.from] && s.needed[e.to]
	}
	return false
}

// runs simulates the needed nodes before target, or all of them for the
// output, in an order a run could start them, each after every one it waits
// on. It says false, running none, when target never gets in, being on or
// after a loop of connections.
func (s *sim) runs(target int) bool {
	waiting := make([]int, len(s.p.nodes))
	var ready, order []int
	for i, n := range s.p.nodes {
		if !s.needed[i] {
			continue
		}
		for _, k := range n.in {
			if s.needed[s.p.edges[k].from] {
				waiting[i]++
			}
		}
		if waiting[i] == 0 {
			ready = append(ready, i)
		}
	}
	for len(ready) > 0 {
		i := ready[0]
		ready = ready[1:]
		order = append(order, i)
		for _, k := range s.p.nodes[i].out {
			if j := s.p.edges[k].to; s.needed[j] {
				if waiting[j]--; waiting[j] == 0 {
					ready = append(ready, j)
				}
			}
		}
	}
	if target >= 0 && !slices.Contains(order, target) {
		return false
	}
	for _, i := range order {
		if i != target {
			s.run(i)
		}
	}
	return true
}

// reached says whether a run would start node i, by the connections into
// it that might be taken, as a run joins them.
func (s *sim) reached(i int) bool {
	return s.p.joins(i, s.might)
}

// might says whether a run might take edge k: it does, or the preview
// couldn't run its source, for want of a sample or a working expression,
// so it can't tell. One from a step it skipped isn't taken.
func (s *sim) might(k int) bool {
	from := s.p.edges[k].from
	return s.taken[k] || !s.skipped[from] && s.entry[from] == nil
}

// parts is what node i's expressions see: its ancestors that ran, as a
// run's are.
func (s *sim) parts(i int) []docPart {
	var out []docPart
	for _, a := range s.p.nodes[i].ancestors {
		if a != i && s.entry[a] != nil {
			out = append(out, docPart{id: s.p.nodes[a].id, entry: s.entry[a]})
		}
	}
	return out
}

// run simulates a node before the one previewed: an http node answers with
// a sample, a transform gives its value, and one that fails into its
// Unhandled block gives a made-up failure.
func (s *sim) run(i int) {
	n := &s.p.nodes[i]
	if !s.reached(i) {
		s.skipped[i] = true
		return
	}
	switch {
	case s.via[i] == workflow.OnUnhandled:
		entry, err := s.failed(i)
		if err != nil {
			s.problem("/nodes/"+strconv.Itoa(i)+"/unhandled/body", "evaluation_failed", "%v", err)
			return
		}
		s.entry[i] = entry
	case n.calls != nil:
		entry, ok := s.called(i)
		if !ok {
			return
		}
		s.entry[i] = entry
	case n.kind == workflow.NodeKindHTTP:
		sample, ptr, status := s.sample(i)
		switch {
		case ptr == "":
			return // an output the node doesn't list: the connection's problem says so
		case sample == nil:
			what := "response"
			if s.via[i] != 0 {
				what = fmt.Sprintf("for its %d response", s.via[i])
			}
			s.problem(ptr, "missing_sample", "%s has no sample %s, so what it gets back isn't there to read", n.id, what)
			return
		}
		entry, err := sampleEntry(sample, status)
		if err != nil {
			s.problem(ptr, "evaluation_failed", "%v", err)
			return
		}
		s.entry[i] = entry
	case n.kind == workflow.NodeKindTransform && n.whole:
		doc, err := document(s.input, s.parts(i))
		var status int
		var v json.RawMessage
		part := "/expr"
		if err == nil {
			status, v, part, err = n.give(s.ctx, doc)
		}
		if err != nil {
			s.problem("/nodes/"+strconv.Itoa(i)+part, "evaluation_failed", "%v", unnamed(err))
			return
		}
		// A switch exits by the case that holds, wherever its lines lead.
		s.entry[i], s.via[i] = transformEntry(status, v), status
	default:
		return // a kind the engine doesn't know, or an expr that doesn't compile: its problem says so
	}
	s.conditions(i)
}

// sample is what http node i answers with: the sample of the output it
// answers through, where that sample sits, and the status it answers with.
// The sample is nil when there's none; the place is empty too when the
// output isn't one the node lists.
func (s *sim) sample(i int) (sample *workflow.Sample, pointer string, status int) {
	n := s.d.Nodes[i]
	ptr := "/nodes/" + strconv.Itoa(i)
	on := s.via[i]
	if on == 0 {
		if n.Sample != nil {
			status = n.Sample.Status
		}
		return n.Sample, ptr + "/sample", cmp.Or(status, http.StatusOK)
	}
	j := slices.IndexFunc(n.Outputs, func(o workflow.Output) bool { return o.Status == on })
	if j < 0 {
		return nil, "", on
	}
	return n.Outputs[j].Sample, fmt.Sprintf("%s/outputs/%d/sample", ptr, j), on
}

// conditions decides which of node i's connections are taken, as a run
// does: of those from the output it answered through, the ones whose
// condition holds over what it reads and what it gave. One whose condition
// fails counts as taken, and says why. A connection to a node the preview
// doesn't run isn't its business.
func (s *sim) conditions(i int) {
	n := &s.p.nodes[i]
	doc, docErr := document(s.input, append(s.parts(i), docPart{id: n.id, entry: s.entry[i]}))
	for _, k := range n.out {
		e := s.p.edges[k]
		if !s.needed[e.to] || e.on != s.via[i] {
			continue
		}
		if e.when == nil {
			s.taken[k] = true
			continue
		}
		err := docErr
		if err == nil {
			var ok bool
			if ok, err = e.when.Eval(s.ctx, doc); err == nil {
				s.taken[k] = ok
				continue
			}
		}
		s.taken[k] = true
		s.problem("/edges/"+strconv.Itoa(k)+"/when", "evaluation_failed", "%v", err)
	}
}

// step previews node t itself: what it reads, and what it sends or gives.
// It says whether the run starts t.
func (s *sim) step(pv *Preview, t int) bool {
	n := &s.p.nodes[t]
	ptr := "/nodes/" + strconv.Itoa(t)
	pv.Skipped = !s.reached(t)
	doc, err := document(s.input, s.parts(t))
	if err != nil {
		s.problem(ptr, "evaluation_failed", "%v", err)
		return false
	}
	pv.Reads = doc
	if pv.Skipped {
		return false
	}
	switch {
	case n.calls != nil:
		// What it gives the workflow, and what the workflow answers when it
		// succeeds (plan 07).
		given, errs := n.params(s.ctx, doc)
		pv.Parameters = given
		for _, e := range errs {
			s.problem(ptr+e.pointer, "evaluation_failed", "%v", e.err)
		}
		if status, body, ok := s.answered(t, given, 0); ok {
			pv.Gives = answerJSON(status, body)
		}
	case n.kind == workflow.NodeKindHTTP && s.d.Nodes[t].Request != nil:
		if n.bound {
			// What the request reads; those that fail are its problems,
			// which request says.
			pv.Parameters, _ = n.params(s.ctx, doc)
		}
		req, errs := n.request(s.ctx, doc, "<run id>:"+n.id)
		pv.Sends = req
		for _, e := range errs {
			s.problem(ptr+e.pointer, "evaluation_failed", "%v", e.err)
		}
	case n.kind == workflow.NodeKindTransform && n.whole:
		status, body, part, err := n.give(s.ctx, doc)
		switch {
		case err != nil:
			s.problem(ptr+part, "evaluation_failed", "%v", unnamed(err))
		case n.cases == nil:
			pv.Gives = body
		default:
			// The case that holds: its status, and its body, if it gives one.
			if pv.Gives, err = json.Marshal(struct {
				Status int             `json:"status"`
				Body   json.RawMessage `json:"body,omitempty"`
			}{status, body}); err != nil {
				s.problem(ptr, "evaluation_failed", "%v", err)
			}
		}
	}
	return true
}

// called is node i's part of the data document, a node that uses a
// workflow (plan 07): what the workflow answers through the output i
// answers through, by the workflow's own preview, over the values i gives
// its parameters.
func (s *sim) called(i int) (json.RawMessage, bool) {
	n := &s.p.nodes[i]
	ptr := "/nodes/" + strconv.Itoa(i)
	doc, err := document(s.input, s.parts(i))
	if err != nil {
		s.problem(ptr, "evaluation_failed", "%v", err)
		return nil, false
	}
	given, errs := n.params(s.ctx, doc)
	for _, e := range errs {
		s.problem(ptr+e.pointer, "evaluation_failed", "%v", e.err)
	}
	status, body, ok := s.answered(i, given, s.via[i])
	if !ok {
		return nil, false
	}
	entry, err := responseEntry(status, nil, body)
	if err != nil {
		s.problem(ptr, "evaluation_failed", "%v", err)
		return nil, false
	}
	return entry, true
}

// answered previews what the workflow node i uses answers through output
// on, a status, or 0 for its first 2xx: its own preview over given, the
// values i gives its parameters, its sample input standing in for any i
// doesn't give. When it can't tell, a problem of i's says why. It goes as
// deep as a run of the draft, which starts at no hops: a run as many hops
// in as trace.MaxHops is refused (plan 06).
func (s *sim) answered(i int, given json.RawMessage, on int) (int, json.RawMessage, bool) {
	n := &s.p.nodes[i]
	ptr := "/nodes/" + strconv.Itoa(i) + "/uses"
	w := s.deps.Revisions[*n.calls]
	if w == nil {
		return 0, nil, false // Resolve's problem says why
	}
	what := "its 2xx answer"
	if on != 0 {
		what = fmt.Sprintf("its %d answer", on)
	}
	if s.depth+1 >= trace.MaxHops {
		s.problem(ptr, "missing_sample", "%s's workflow has no preview of %s: a run refuses it, as the call would pass through Conduit %d times", n.id, what, trace.MaxHops)
		return 0, nil, false
	}
	rd, _ := workflow.Resolve(w, s.deps, "")
	inner, problems := newSim(s.ctx, rd, s.deps)
	inner.depth, inner.input = s.depth+1, over(w.SampleInput, given)
	status, body, why := inner.answer(problems, on)
	if why != nil {
		// One a workflow deeper in says of its own is said once.
		detail := why.Detail
		if why.Code != "missing_sample" || !strings.HasSuffix(why.Pointer, "/uses") {
			detail = fmt.Sprintf("%s's workflow has no preview of %s: %s", n.id, what, why.Detail)
		}
		s.problem(ptr, "missing_sample", "%s", detail)
		return 0, nil, false
	}
	return status, body, true
}

// over is given, an object, over sample, so a field given has its value
// and the rest their sample's. sample that isn't an object gives nothing.
func over(sample, given json.RawMessage) json.RawMessage {
	var fields map[string]json.RawMessage
	if json.Unmarshal(sample, &fields) != nil || fields == nil {
		fields = map[string]json.RawMessage{}
	}
	var g map[string]json.RawMessage
	if json.Unmarshal(given, &g) == nil {
		maps.Copy(fields, g)
	}
	out, err := json.Marshal(fields)
	if err != nil {
		return json.RawMessage("{}")
	}
	return out
}

// answer previews what this workflow answers through output on: its
// answer with that status, or its first 2xx for 0, as the answer's first
// line gives it, that line's node answering through it and the steps before
// that node as a preview of it has them. why is what's in the way.
func (s *sim) answer(problems workflow.Problems, on int) (status int, body json.RawMessage, why *workflow.Problem) {
	says := func(detail string) (int, json.RawMessage, *workflow.Problem) {
		return 0, nil, &workflow.Problem{Detail: detail}
	}
	resp := s.d.Response
	if resp == nil {
		return says("it has no response")
	}
	k := slices.IndexFunc(resp.Answers, func(a workflow.Answer) bool {
		if on == 0 {
			return a.Status >= 200 && a.Status <= 299
		}
		return a.Status == on
	})
	if k < 0 || len(resp.Answers[k].Lines) == 0 {
		return says("no line joins that answer")
	}
	a := resp.Answers[k]
	l := a.Lines[0]
	from := slices.IndexFunc(s.d.Nodes, func(n workflow.Node) bool { return n.ID == l.From })
	if from < 0 {
		return says("its line comes from no step")
	}
	s.aim(from, problems)
	s.via[from] = l.Output()
	if !s.runs(from) {
		return says("its line's step is on or after a loop of connections, so it never runs")
	}
	s.run(from)
	if s.entry[from] == nil {
		if len(s.problems) > 0 {
			return 0, nil, &s.problems[0]
		}
		return says("with these samples, a run skips its line's step")
	}
	status, body, err := s.lineBody(from, l.Output(), a.Status)
	switch {
	case err != nil:
		return says(err.Error())
	case on == 0 && (status < 200 || status > 299), on != 0 && status != on:
		return says(fmt.Sprintf("with these samples, %s picks %d", l.From, status))
	}
	return status, body, nil
}

// lineBody is what the answer with status gives through a line from node
// i's output on, as a run's answer has it: what i's Unhandled body gave; the
// error it passes on, from an Unhandled with no body or an http node's
// status of 400 or more; what a transform that picks among answers picked,
// at the status it picked; or its body.
func (s *sim) lineBody(i, on, status int) (int, json.RawMessage, error) {
	var e struct {
		Body json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal(s.entry[i], &e); err != nil {
		return 0, nil, err
	}
	n := &s.p.nodes[i]
	switch statuses := s.p.response.picks[i]; {
	case on == workflow.OnUnhandled && n.unhandled != nil:
		return status, e.Body, nil
	case on == workflow.OnUnhandled, n.kind == workflow.NodeKindHTTP && on >= 400:
		body, err := s.passedOn(i, on, e.Body)
		return status, body, err
	case len(statuses) >= 2:
		return pick(n.id, e.Body, statuses)
	default:
		return status, e.Body, nil
	}
}

// passedOn is the body an answer passing node i's error on gives in a
// preview, through output on, with body what i got: the response's error
// body over the error, made up as a preview calls nothing; or, with none,
// the error as a node that uses the workflow gets it, its code, detail and
// node (plan 07).
func (s *sim) passedOn(i, on int, body json.RawMessage) (json.RawMessage, error) {
	n := &s.p.nodes[i]
	res := NodeResult{ID: n.id, HTTPStatus: on, Body: body}
	code, detail := CodeUpstream, fmt.Sprintf("%s answered %d: made up, as a preview calls nothing", n.id, on)
	if on == workflow.OnUnhandled {
		res = NodeResult{ID: n.id}
		detail = n.id + " failed: made up, as a preview calls nothing"
		if n.kind != workflow.NodeKindHTTP {
			code = CodeWorkflow
		}
	}
	if s.p.response.errors == nil {
		return json.Marshal(ErrorAnswer{Code: code, Detail: detail, Node: n.id})
	}
	failure, err := ErrorOf(res, code, detail)
	if err != nil {
		return nil, err
	}
	var parts []docPart
	for k, e := range s.entry {
		if e != nil {
			parts = append(parts, docPart{id: s.p.nodes[k].id, entry: e})
		}
	}
	doc, err := document(s.input, parts)
	if err != nil {
		return nil, err
	}
	doc = append(append(append(doc[:len(doc)-1], `,"error":`...), failure...), '}')
	out, err := s.p.response.errors.Eval(s.ctx, doc)
	if err != nil {
		return nil, fmt.Errorf("its error body failed: %w", err)
	}
	return out, nil
}

// ErrorAnswer is the body a node that uses a workflow gets when the
// workflow's answer passes an error on with no error body to say it, where
// /serve answers with problem details (plan 07).
type ErrorAnswer struct {
	Code   string `json:"code"`
	Detail string `json:"detail"`
	Node   string `json:"node"`
}

// answerJSON is an answer as a preview gives it: its status and body.
func answerJSON(status int, body json.RawMessage) json.RawMessage {
	if body == nil {
		body = json.RawMessage("null")
	}
	return fmt.Appendf(nil, `{"status":%d,"body":%s}`, status, body)
}

// output previews the workflow's output, over every node that ran, as a
// run's is.
func (s *sim) output(pv *Preview) {
	var parts []docPart
	for i, e := range s.entry {
		if e != nil {
			parts = append(parts, docPart{id: s.p.nodes[i].id, entry: e})
		}
	}
	doc, err := document(s.input, parts)
	if err != nil {
		s.problem("/output", "evaluation_failed", "%v", err)
		return
	}
	pv.Reads = doc
	if s.p.output == nil {
		return
	}
	if pv.Gives, err = s.p.output.Eval(s.ctx, doc); err != nil {
		s.problem("/output", "evaluation_failed", "%v", err)
	}
}

// madeUpFailure is node n's part of the data document when it fails into
// its Unhandled block, as a preview has it: an error, no answer, and body,
// when its Unhandled body gave one.
func madeUpFailure(n *node, body json.RawMessage) (json.RawMessage, error) {
	code := CodeWorkflow
	if n.kind == workflow.NodeKindHTTP {
		code = CodeUpstream
	}
	return failureEntry(0, nil, body, code, n.id+" failed: made up, as a preview calls nothing")
}

// failed is node i's part of the data document as it fails into its
// Unhandled block in a preview: an error made up, and what its Unhandled
// body gives over that, when it has one.
func (s *sim) failed(i int) (json.RawMessage, error) {
	n := &s.p.nodes[i]
	entry, err := madeUpFailure(n, nil)
	if err != nil || n.unhandled == nil {
		return entry, err
	}
	doc, err := document(s.input, append(s.parts(i), docPart{id: n.id, entry: entry}))
	if err != nil {
		return nil, err
	}
	gave, err := n.unhandled.Eval(s.ctx, doc)
	if err != nil {
		return nil, err
	}
	return madeUpFailure(n, gave)
}

// unhandled previews step t's Unhandled body: over what t reads, with t
// failing into the block, an error made up.
func (s *sim) unhandled(pv *Preview, t int) {
	n := &s.p.nodes[t]
	ptr := "/nodes/" + strconv.Itoa(t) + "/unhandled/body"
	entry, err := madeUpFailure(n, nil)
	var doc json.RawMessage
	if err == nil {
		doc, err = document(s.input, append(s.parts(t), docPart{id: n.id, entry: entry}))
	}
	if err != nil {
		s.problem(ptr, "evaluation_failed", "%v", err)
		return
	}
	pv.Unhandled = &UnhandledPreview{Reads: doc}
	if pv.Unhandled.Gives, err = n.unhandled.Eval(s.ctx, doc); err != nil {
		s.problem(ptr, "evaluation_failed", "%v", err)
	}
}

// sampleEntry is an http node's part of the data document, from a sample
// it answers with status, as a run builds it from a response: header names
// in lower case.
func sampleEntry(sample *workflow.Sample, status int) (json.RawMessage, error) {
	header := make(http.Header, len(sample.Headers))
	for name, v := range sample.Headers {
		header[name] = []string{v}
	}
	return httpEntry(&upstream.Response{Status: status, Header: header, Body: sample.Body})
}
