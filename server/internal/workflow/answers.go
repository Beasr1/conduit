package workflow

import (
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
)

// group is the answers joined to one output of one node: from node from, on
// output on, a status, 0 for 2xx and a transform's one output, or
// OnUnhandled.
type group struct {
	from, on int
	answers  []int // places in response.answers
}

// checkResponse checks what the workflow answers. Each answer has a status,
// listed once, and one line, from a node and an output it has, its
// Unhandled block among them. A node joined to several answers from one
// output picks among them, so it's a transform; a switch gives the statuses of the answers it's joined to. Two
// lines one run could both take are a problem, judged from the graph alone.
// A definition answers through its response, or, kept for the revisions
// saved with one, its output; not both.
func (v *validator) checkResponse(d *Definition, index map[string]int, edges []edgeRef, cyclic bool) {
	r := d.Response
	if r == nil {
		return
	}
	if d.Output != "" {
		v.add("/output", "not_allowed", "a definition with a response has no output: the nodes joined to its answers give them")
	}
	if r.Unhandled != nil && strings.TrimSpace(r.Unhandled.Body) == "" {
		v.add("/response/unhandled/body", "required", "unhandled needs a body")
	}
	if len(r.Answers) == 0 {
		v.add("/response/answers", "required", "a response needs at least one answer")
		return
	}
	seen := make(map[int]int, len(r.Answers))
	var groups []group
	for k, a := range r.Answers {
		p := fmt.Sprintf("/response/answers/%d", k)
		switch j, dup := seen[a.Status]; {
		case a.Status == 0:
			v.add(p+"/status", "required", "an answer needs a status")
		case a.Status < 200 || a.Status > 599:
			v.add(p+"/status", "invalid_status", "an answer's status is 200 to 599; %d isn't", a.Status)
		case dup:
			v.add(p+"/status", "duplicate_answer", "/response/answers/%d already has the status %d", j, a.Status)
		default:
			seen[a.Status] = k
		}
		from, ok := index[a.From]
		switch {
		case a.From == "":
			v.add(p+"/from", "required", "join a node to the %d answer", a.Status)
			continue
		case !ok:
			v.add(p+"/from", "unknown_node", "no node has the id %q", a.From)
			continue
		}
		if a.Unhandled && a.On != 0 {
			v.add(p+"/unhandled", "not_allowed", "a line leaves from one block: %s's %d output or its Unhandled", a.From, a.On)
			continue
		}
		if a.On != 0 {
			switch n := d.Nodes[from]; n.Kind {
			case NodeKindHTTP:
				if !slices.ContainsFunc(n.Outputs, func(o Output) bool { return o.Status == a.On }) {
					v.add(p+"/on", "unknown_output", "%s has no %d output", a.From, a.On)
					continue
				}
			case NodeKindTransform:
				v.add(p+"/on", "not_allowed", "a transform node has one output, so a line from it names none")
				continue
			}
		}
		on := a.Output()
		i := slices.IndexFunc(groups, func(g group) bool { return g.from == from && g.on == on })
		if i < 0 {
			groups = append(groups, group{from: from, on: on})
			i = len(groups) - 1
		}
		groups[i].answers = append(groups[i].answers, k)
	}
	for _, g := range groups {
		v.checkGroup(d, g)
	}
	if !cyclic {
		v.checkReach(d, groups, edges)
	}
}

// checkGroup checks the answers joined to one output of one node. An http
// node's result is the response it got, so it gives one answer, and so does
// a node's Unhandled block, as a failure has no status of the node's own to
// pick with. A switch gives the answers it's joined to: each of its
// statuses is one, and each one is among its statuses.
func (v *validator) checkGroup(d *Definition, g group) {
	n, answers := d.Nodes[g.from], d.Response.Answers
	statuses := make([]int, len(g.answers))
	for i, k := range g.answers {
		statuses[i] = answers[k].Status
	}
	if g.on == OnUnhandled {
		if len(statuses) > 1 {
			v.add(fmt.Sprintf("/response/answers/%d/from", g.answers[1]), "not_allowed",
				"%s's Unhandled is joined to %s: a failure has no status to pick one with, so it gives one answer; to pick among several, join a transform that does",
				n.ID, statusList(statuses))
		}
		return
	}
	if n.Kind == NodeKindHTTP && len(statuses) > 1 {
		v.add(fmt.Sprintf("/response/answers/%d/from", g.answers[1]), "not_allowed",
			"%s's %s output is joined to %s: an http node's result is the response it got, so it gives one answer; to pick among several, join a transform that does",
			n.ID, outputName(g.on), statusList(statuses))
	}
	s := n.Switch
	if n.Kind != NodeKindTransform || s == nil {
		return
	}
	p := fmt.Sprintf("/nodes/%d/switch", g.from)
	gives := []int{s.Otherwise.Status}
	for k, c := range s.Cases {
		if c.Status != 0 && !slices.Contains(statuses, c.Status) {
			v.add(fmt.Sprintf("%s/cases/%d/status", p, k), "unknown_answer", "%s isn't joined to a %d answer", n.ID, c.Status)
		}
		gives = append(gives, c.Status)
	}
	if o := s.Otherwise.Status; o != 0 && !slices.Contains(statuses, o) {
		v.add(p+"/otherwise/status", "unknown_answer", "%s isn't joined to a %d answer", n.ID, o)
	}
	for _, k := range g.answers {
		if status := answers[k].Status; !slices.Contains(gives, status) {
			v.add(fmt.Sprintf("/response/answers/%d/from", k), "never_given",
				"%s never gives %d: add a case for it, or join another node to it", n.ID, status)
		}
	}
}

// checkReach reports two outputs joined to answers that one run could both
// take. A run takes a line only when its node runs and answers through its
// output, and a node runs only when a line into it is taken, so two lines
// rest apart only on different outputs of one node they both need.
// Conditions aren't read: lines only they keep apart are reported too.
func (v *validator) checkReach(d *Definition, groups []group, edges []edgeRef) {
	need := needs(len(d.Nodes), edges)
	answers := d.Response.Answers
	for i, a := range groups {
		for _, b := range groups[i+1:] {
			if apart(with(need[a.from], a), with(need[b.from], b)) {
				continue
			}
			ka, kb := a.answers[0], b.answers[0]
			v.add(fmt.Sprintf("/response/answers/%d/from", kb), "overlap",
				"%d (%s) and %d (%s) can both be reached in one run: merge them into one node",
				answers[ka].Status, d.Nodes[a.from].ID, answers[kb].Status, d.Nodes[b.from].ID)
		}
	}
}

// needs is, for each node, the outputs it runs only after, by node: a
// status, 0 for 2xx and a transform's one output, or OnUnhandled. A node runs once a
// line into it is taken, so it needs what every line into it needs: the
// line's node, answering through the line's output, and what that node
// needs. A node with no line into it needs nothing. edges have no cycle.
func needs(n int, edges []edgeRef) []map[int]int {
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
	need := make([]map[int]int, n)
	for _, u := range order {
		for j, e := range in[u] {
			route := with(need[e.from], group{from: e.from, on: e.on})
			if j == 0 {
				need[u] = route
				continue
			}
			maps.DeleteFunc(need[u], func(x, on int) bool {
				o, ok := route[x]
				return !ok || o != on
			})
		}
	}
	return need
}

// with is what a line from output g needs: what its node needs, and the
// node answering through that output.
func with(need map[int]int, g group) map[int]int {
	out := maps.Clone(need)
	if out == nil {
		out = map[int]int{}
	}
	out[g.from] = g.on
	return out
}

// apart says whether two lines can't both be taken in one run: they need
// different outputs of one node.
func apart(a, b map[int]int) bool {
	for x, on := range a {
		if o, ok := b[x]; ok && o != on {
			return true
		}
	}
	return false
}

// outputName is an output as a problem names it: "2xx", or its status.
func outputName(on int) string {
	if on == 0 {
		return "2xx"
	}
	return strconv.Itoa(on)
}

// statusList is statuses in words: "200", "200 and 404", "200, 404 and 409".
func statusList(statuses []int) string {
	words := make([]string, len(statuses))
	for i, s := range statuses {
		words[i] = strconv.Itoa(s)
	}
	if len(words) < 2 {
		return strings.Join(words, "")
	}
	return strings.Join(words[:len(words)-1], ", ") + " and " + words[len(words)-1]
}
