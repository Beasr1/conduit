package workflow

import (
	"slices"
)

// Outcome is what a node before another may have done in a run that
// reaches that one: the outputs it may have answered through, sorted (a
// status, 0 for 2xx and a transform's one value, or OnUnhandled), and
// whether the run may have skipped it.
type Outcome struct {
	Outputs     []int
	Conditional bool
}

// Outcomes is what each node before node i may have done in a run that
// starts i, by the node's place: what i's route needs of it, or, for a node
// the route says nothing of, any of its outputs, conditional unless it
// always runs. It's nil when i never runs, or the edges have a cycle.
func Outcomes(d *Definition, i int) map[int]Outcome {
	if i < 0 || i >= len(d.Nodes) {
		return nil
	}
	var v validator
	index := make(map[string]int, len(d.Nodes))
	for j, n := range d.Nodes {
		if _, taken := index[n.ID]; !taken && n.ID != "" {
			index[n.ID] = j
		}
	}
	edges, cyclic := v.checkEdges(d.Edges, d.Nodes, index)
	if cyclic {
		return nil
	}
	in, order := graphOf(len(d.Nodes), edges)
	need, _ := needs(d.Nodes, in, order)
	if need[i] == nil {
		return nil
	}
	outs := outputsOf(d, edges)
	always := alwaysRuns(d, in, order, outs)
	out := make(map[int]Outcome)
	for _, x := range before(i, in) {
		set, ok := need[i][x]
		if !ok {
			out[x] = Outcome{Outputs: outs[x], Conditional: !always[x]}
			continue
		}
		out[x] = Outcome{
			Outputs:     slices.DeleteFunc(slices.Clone(set), func(on int) bool { return on == notRun }),
			Conditional: slices.Contains(set, notRun),
		}
	}
	return out
}

// before is the nodes with a path of edges to node i.
func before(i int, in [][]edgeRef) []int {
	seen := make([]bool, len(in))
	stack := []int{i}
	var out []int
	for len(stack) > 0 {
		u := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, e := range in[u] {
			if !seen[e.from] {
				seen[e.from] = true
				out = append(out, e.from)
				stack = append(stack, e.from)
			}
		}
	}
	return out
}

// outputsOf is the outputs each node may answer through, sorted: an http
// node's 2xx and each status it lists, a transform's cases' statuses or its
// one value, and its Unhandled when a line leaves that, as its failure goes
// there rather than failing the run.
func outputsOf(d *Definition, edges []edgeRef) [][]int {
	catches := make([]bool, len(d.Nodes))
	for _, e := range edges {
		if e.on == OnUnhandled {
			catches[e.from] = true
		}
	}
	if r := d.Response; r != nil {
		for _, a := range r.Answers {
			for _, l := range a.Lines {
				if j := slices.IndexFunc(d.Nodes, func(n Node) bool { return n.ID == l.From }); j >= 0 && l.Unhandled {
					catches[j] = true
				}
			}
		}
	}
	out := make([][]int, len(d.Nodes))
	for j, n := range d.Nodes {
		var set []int
		switch {
		case n.Kind == NodeKindTransform && n.Switch != nil:
			for _, c := range n.Switch.Cases {
				set = append(set, c.Status)
			}
		default:
			set = []int{0}
			for _, o := range n.Outputs {
				set = append(set, o.Status)
			}
		}
		if catches[j] {
			set = append(set, OnUnhandled)
		}
		slices.Sort(set)
		out[j] = slices.Compact(set)
	}
	return out
}

// alwaysRuns says of each node whether every run that gets past it runs it:
// one no edge comes into does, and so does one whose edges always come, as
// its join needs them, each without a condition from a node that always
// runs and answers only through that edge's output. edges have no cycle.
func alwaysRuns(d *Definition, in [][]edgeRef, order []int, outs [][]int) []bool {
	always := make([]bool, len(d.Nodes))
	sure := func(e edgeRef) bool {
		return always[e.from] && d.Edges[e.index].When == "" && slices.Equal(outs[e.from], []int{e.on})
	}
	for _, u := range order {
		lines := in[u]
		merges := d.Nodes[u].Kind == NodeKindTransform && !slices.ContainsFunc(lines, func(e edgeRef) bool { return e.required })
		switch {
		case len(lines) == 0:
			always[u] = true
		case merges:
			always[u] = slices.ContainsFunc(lines, sure)
		default:
			// An http node needs every edge, and a transform its required ones.
			needed := func(e edgeRef) bool { return e.required || d.Nodes[u].Kind != NodeKindTransform }
			always[u] = !slices.ContainsFunc(lines, func(e edgeRef) bool { return needed(e) && !sure(e) })
		}
	}
	return always
}
