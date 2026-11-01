package workflow

import (
	"fmt"
	"maps"
	"slices"
	"strings"
)

// route is what a node runs only after: for each node it needs, the outputs
// that node may answer through, sorted. A nil route is a node that never
// runs.
type route map[int][]int

// conflict is why a node never runs: it needs node of to answer through
// one of a, and through one of b, which share none.
type conflict struct {
	node, of int
	a, b     []int
}

// checkJoins works out what each node runs only after, and reports each
// node that can never run, where that starts: a node runs once each node
// with a line into it took one of them (plan 04, strict joins). edges have
// no cycle.
func (v *validator) checkJoins(d *Definition, edges []edgeRef) []route {
	need, conflicts := needs(len(d.Nodes), edges)
	for _, c := range conflicts {
		v.add(fmt.Sprintf("/nodes/%d", c.node), "never_runs", "%s can never run: it needs %s to answer %s and %s",
			d.Nodes[c.node].ID, d.Nodes[c.of].ID, outputsName(c.a), outputsName(c.b))
	}
	return need
}

// needs is each node's route. A node runs once each node with a line into
// it has answered through one of those lines, so it needs, of each such
// node, the outputs those lines leave from, and what that node needs. Two
// needs of one node sharing no output leave it none: the node never runs,
// and conflicts says why, for each node where that starts. The nodes after
// it never run either.
func needs(n int, edges []edgeRef) ([]route, []conflict) {
	in := make([][]edgeRef, n)
	out := make([][]edgeRef, n)
	waiting := make([]int, n)
	for _, e := range edges {
		in[e.to] = append(in[e.to], e)
		out[e.from] = append(out[e.from], e)
		waiting[e.to]++
	}
	// Each node after every node with a line into it.
	var order []int
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
	need := make([]route, n)
	var conflicts []conflict
	for _, u := range order {
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
	// The outputs each node's lines into u leave from, by node, in order:
	// a set, as a node joins another once per output.
	var froms []int
	outs := map[int][]int{}
	for _, e := range in {
		if _, ok := outs[e.from]; !ok {
			froms = append(froms, e.from)
		}
		outs[e.from] = append(outs[e.from], e.on)
	}
	for _, set := range outs {
		slices.Sort(set)
	}
	r := route{}
	for _, from := range froms {
		if need[from] == nil {
			return nil, nil // it never runs, so u doesn't either
		}
		for _, x := range slices.Sorted(maps.Keys(need[from])) {
			if had, ok := narrow(r, x, need[from][x]); !ok {
				return nil, &conflict{node: u, of: x, a: had, b: need[from][x]}
			}
		}
		if had, ok := narrow(r, from, outs[from]); !ok {
			return nil, &conflict{node: u, of: from, a: had, b: outs[from]}
		}
	}
	return r, nil
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

// outputsName is outputs in words, as a problem names them: "2xx", or
// "2xx or 404".
func outputsName(set []int) string {
	words := make([]string, len(set))
	for i, on := range set {
		words[i] = outputName(on)
	}
	return strings.Join(words, " or ")
}
