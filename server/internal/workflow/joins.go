package workflow

import (
	"fmt"
	"maps"
	"slices"
	"strings"
)

// route is what a node runs only after: for each node it needs, the outputs
// that node may answer through, sorted, notRun among them where a transform
// lets the node not run. A nil route is a node that never runs.
type route map[int][]int

// notRun is a node not running, counted beside its outputs: a transform's
// route allows it of a node that one of its ways rules out.
const notRun = -2

// conflict is why a node never runs: it needs node of to answer through
// one of a, and through one of b, which share none.
type conflict struct {
	node, of int
	a, b     []int
}

// checkJoins works out what each node runs only after, and reports each
// node that can never run, where that starts: an http node runs only if
// every line into it was taken (plan 04, strict joins), and a transform if
// any was. edges have no cycle.
func (v *validator) checkJoins(d *Definition, edges []edgeRef) []route {
	in, order := graphOf(len(d.Nodes), edges)
	need, conflicts := needs(d.Nodes, in, order)
	for _, c := range conflicts {
		v.add(fmt.Sprintf("/nodes/%d", c.node), "never_runs", "%s can never run: %s", d.Nodes[c.node].ID, c.words(d))
	}
	return need
}

// graphOf is the edges into each node, and an order in which each node
// comes after every node with an edge into it.
func graphOf(n int, edges []edgeRef) (in [][]edgeRef, order []int) {
	in = make([][]edgeRef, n)
	out := make([][]edgeRef, n)
	waiting := make([]int, n)
	for _, e := range edges {
		in[e.to] = append(in[e.to], e)
		out[e.from] = append(out[e.from], e)
		waiting[e.to]++
	}
	for i := range n {
		if waiting[i] == 0 {
			order = append(order, i)
		}
	}
	for k := 0; k < len(order); k++ {
		for _, e := range out[order[k]] {
			if waiting[e.to]--; waiting[e.to] == 0 {
				order = append(order, e.to)
			}
		}
	}
	return in, order
}

// needs is each node's route. An http node runs once every line into it
// was taken, so it needs each line's node to answer through the output the
// line leaves from, and what that node needs. Two needs of one node sharing
// no output leave it none: the node never runs, and conflicts says why, for
// each node where that starts. The nodes after it never run either. A
// transform with a line into it needs what one of its ways does.
func needs(nodes []Node, in [][]edgeRef, order []int) ([]route, []conflict) {
	need := make([]route, len(nodes))
	var conflicts []conflict
	for _, u := range order {
		if nodes[u].Kind == NodeKindTransform && len(in[u]) > 0 {
			need[u] = mergeOf(in[u], need)
			continue
		}
		r, c := joinOf(u, in[u], need)
		if c != nil {
			conflicts = append(conflicts, *c)
		}
		need[u] = r
	}
	return need, conflicts
}

// joinOf is node u's route, from the lines into it and what their nodes
// need, or nil when u never runs. The conflict says why, when that starts
// at u rather than at a node before it.
func joinOf(u int, in []edgeRef, need []route) (route, *conflict) {
	r := route{}
	for _, e := range in {
		if need[e.from] == nil {
			return nil, nil // it never runs, so u doesn't either
		}
		for _, x := range slices.Sorted(maps.Keys(need[e.from])) {
			if had, ok := narrow(r, x, need[e.from][x]); !ok {
				return nil, &conflict{node: u, of: x, a: had, b: need[e.from][x]}
			}
		}
		if had, ok := narrow(r, e.from, []int{e.on}); !ok {
			return nil, &conflict{node: u, of: e.from, a: had, b: []int{e.on}}
		}
	}
	return r, nil
}

// mergeOf is a transform's route, from the edges into it: each way's, what its
// node needs and that node answering through the edge, merged, as it runs
// when any of them came. It allows a node what any way does, and notRun
// where a way rules the node out; a way that does neither lets the node be
// anything, so the merge needs nothing of it. Ways that differ in two nodes
// are read as independent, which allows more than one run can do. It's nil,
// never running, when no way can be taken.
func mergeOf(in []edgeRef, need []route) route {
	var ways []route
	for _, e := range in {
		if need[e.from] != nil {
			ways = append(ways, with(need[e.from], group{from: e.from, on: e.on}))
		}
	}
	if len(ways) == 0 {
		return nil
	}
	r := route{}
	for _, w := range ways {
		for x := range w {
			if _, done := r[x]; !done {
				if set, ok := allowed(x, ways, need); ok {
					r[x] = set
				}
			}
		}
	}
	return r
}

// allowed is what a transform's ways allow node x: the outputs each needs of
// it, or notRun when the way rules x out. ok is false when a way allows x
// anything. A node a way needs runs, so x has a route of its own.
func allowed(x int, ways, need []route) (set []int, ok bool) {
	for _, w := range ways {
		outs, needs := w[x]
		switch {
		case needs:
		case apart(need[x], w):
			outs = []int{notRun}
		default:
			return nil, false
		}
		set = append(set, outs...)
	}
	slices.Sort(set)
	return slices.Compact(set), true
}

// narrow narrows what r needs of node x to the outputs it shares with set,
// and says whether any are left; when none are, had is what it needed.
func narrow(r route, x int, set []int) (had []int, ok bool) {
	have, ok := r[x]
	if !ok {
		r[x] = set
		return nil, true
	}
	both := intersect(have, set)
	if len(both) == 0 {
		return have, false
	}
	r[x] = both
	return nil, true
}

// with is what a line from output g needs: what its node needs, and the
// node answering through that output.
func with(r route, g group) route {
	out := maps.Clone(r)
	out[g.from] = []int{g.on}
	return out
}

// apart says whether two routes can't both be taken in one run: they need
// outputs of one node that share none.
func apart(a, b route) bool {
	for x, as := range a {
		if bs, ok := b[x]; ok && len(intersect(as, bs)) == 0 {
			return true
		}
	}
	return false
}

// intersect is the outputs two sorted sets share, sorted.
func intersect(a, b []int) []int {
	var out []int
	for _, x := range a {
		if _, found := slices.BinarySearch(b, x); found {
			out = append(out, x)
		}
	}
	return out
}

// words is what a conflict needs, as a problem says it: "it needs a to
// answer 404 and 2xx", or, where a merge lets the node not run, "it needs
// t to answer 500, and to answer 2xx or be skipped". Only one of its sets
// can hold notRun, as two that did would share it.
func (c conflict) words(d *Definition) string {
	of, a, b := d.Nodes[c.of].ID, c.a, c.b
	if slices.Contains(a, notRun) {
		a, b = b, a
	}
	if !slices.Contains(b, notRun) {
		return fmt.Sprintf("it needs %s to answer %s and %s", of, outputsName(a), outputsName(b))
	}
	skipped := "to be skipped" // notRun sorts first
	if len(b) > 1 {
		skipped = "to answer " + outputsName(b[1:]) + " or be skipped"
	}
	return fmt.Sprintf("it needs %s to answer %s, and %s", of, outputsName(a), skipped)
}

// outputsName is outputs in words, as a problem names them: "2xx", or
// "2xx or 404".
func outputsName(set []int) string {
	words := make([]string, len(set))
	for i, on := range set {
		words[i] = outputName(on)
	}
	return strings.Join(words, " or ")
}
