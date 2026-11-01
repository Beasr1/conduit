package workflow

import (
	"fmt"
	"slices"
)

// ReadyToPublish is what a definition needs before it's published, beyond
// what Validate checks for a run (plan 12): every way a run can go reaches
// an answer, and each node's failures go where someone chose. Runs don't
// need it, so a revision published before these checks still answers.
func ReadyToPublish(d *Definition) Problems {
	var v validator
	if d.Output != "" {
		return nil // revisions saved with an output answer it, 200, every run
	}
	if d.Response == nil {
		v.add("/response/answers", "no_answers", "the workflow answers nothing: add an answer to its response, and join a step to it")
	}
	index := make(map[string]int, len(d.Nodes))
	for i, n := range d.Nodes {
		if _, taken := index[n.ID]; !taken && n.ID != "" {
			index[n.ID] = i
		}
	}
	var scratch validator // Validate reports what's wrong with the edges
	edges, cyclic := scratch.checkEdges(d.Edges, d.Nodes, index)
	if cyclic {
		return v.problems
	}
	in, order := graphOf(len(d.Nodes), edges)
	need, _ := needs(d.Nodes, in, order)
	outs := outputsOf(d, edges)
	v.checkFailures(d, need, outs)
	if d.Response != nil {
		v.checkLooseEnds(d, edges, index, need, outs)
	}
	return v.problems
}

// checkFailures reports each node whose failures go nowhere anyone chose:
// its Unhandled block has no line or answer from it and isn't set to fail
// the run; or it has both. A node that never runs has a problem of its own.
func (v *validator) checkFailures(d *Definition, need []route, outs [][]int) {
	for i, n := range d.Nodes {
		if need[i] == nil {
			continue
		}
		caught := slices.Contains(outs[i], OnUnhandled)
		fails := n.Unhandled != nil && n.Unhandled.Fail
		switch {
		case caught && fails:
			v.add(fmt.Sprintf("/nodes/%d/unhandled/fail", i), "unhandled_both",
				"%s's Unhandled has a line and is set to fail the run: remove the line, or don't fail the run", n.ID)
		case !caught && !fails:
			v.add(fmt.Sprintf("/nodes/%d/unhandled", i), "unhandled_undecided",
				"say what happens when %s fails: join its Unhandled to a step or an answer, or let it fail the run", n.ID)
		}
	}
}

// checkLooseEnds reports each block a road ends at, no line leaving it and no
// answer joined to it, that no run taking it can answer: every answer's line
// needs a node to have answered otherwise. A block with lines on is judged
// where they end, or never runs or is taken, which are problems of their
// own. One an answer is joined to answers through it. An Unhandled block is
// among a node's outputs only once a line or an answer leaves it, and
// checkFailures has the rest. Routes don't read conditions, so a road only a
// condition may cut isn't reported: a run there gets the error body, at run
// time.
func (v *validator) checkLooseEnds(d *Definition, edges []edgeRef, index map[string]int, need []route, outs [][]int) {
	var answers []group
	for _, a := range d.Response.Answers {
		for _, l := range a.Lines {
			if from, ok := index[l.From]; ok && need[from] != nil {
				answers = append(answers, group{from: from, on: l.Output()})
			}
		}
	}
	leaves := func(s, on int) bool {
		return slices.ContainsFunc(edges, func(e edgeRef) bool { return e.from == s && e.on == on })
	}
	for s, n := range d.Nodes {
		if need[s] == nil {
			continue
		}
		for _, on := range outs[s] {
			if leaves(s, on) {
				continue
			}
			b := with(need[s], group{from: s, on: on})
			if slices.ContainsFunc(answers, func(a group) bool { return !apart(b, with(need[a.from], a)) }) {
				continue
			}
			p, what := blockOf(s, n, on)
			v.add(p, "no_answer", "a run that takes %s's %s gives no answer: join it to an answer, or to a step that leads to one", n.ID, what)
		}
	}
}

// blockOf is where node n's output on is in the definition, and its name:
// a status it lists, a case, a transform's one value, or an http node's
// 2xx, which has no place of its own but the node.
func blockOf(i int, n Node, on int) (pointer, what string) {
	p := fmt.Sprintf("/nodes/%d", i)
	switch {
	case n.Kind == NodeKindTransform && n.Switch != nil:
		k := slices.IndexFunc(n.Switch.Cases, func(c Case) bool { return c.Status == on })
		return fmt.Sprintf("%s/switch/cases/%d", p, k), fmt.Sprintf("case giving %d", on)
	case n.Kind == NodeKindTransform:
		return p + "/expr", "value"
	case on == 0:
		return p, "2xx"
	}
	k := slices.IndexFunc(n.Outputs, func(o Output) bool { return o.Status == on })
	return fmt.Sprintf("%s/outputs/%d", p, k), fmt.Sprintf("%d", on)
}
