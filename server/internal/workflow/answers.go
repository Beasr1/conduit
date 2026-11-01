package workflow

import (
	"fmt"
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
// output picks among them, so it's a transform; a switch gives the
// statuses of the answers it's joined to. Two lines one run could both
// take are a problem, judged from the graph alone.
// A definition answers through its response, or, kept for the revisions
// saved with one, its output; not both.
func (v *validator) checkResponse(d *Definition, index map[string]int, need []route) {
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
			case NodeKindTransform, NodeKindMerge:
				v.add(p+"/on", "not_allowed", "a %s node has one output, so a line from it names none", n.Kind)
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
	if need != nil {
		v.checkReach(d, groups, need)
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
// output, and a node runs only when every line into it was taken, a merge
// when any was, so two lines rest apart only when they need outputs of one
// node that share none. Conditions aren't read: lines only
// they keep apart are reported too, as a switch can pick among answers.
// A line from a node that never runs is that node's problem.
func (v *validator) checkReach(d *Definition, groups []group, need []route) {
	answers := d.Response.Answers
	for i, a := range groups {
		if need[a.from] == nil {
			continue
		}
		for _, b := range groups[i+1:] {
			if need[b.from] == nil || apart(with(need[a.from], a), with(need[b.from], b)) {
				continue
			}
			ka, kb := a.answers[0], b.answers[0]
			v.add(fmt.Sprintf("/response/answers/%d/from", kb), "overlap",
				"%d (%s) and %d (%s) can both be reached in one run: merge them into one node",
				answers[ka].Status, d.Nodes[a.from].ID, answers[kb].Status, d.Nodes[b.from].ID)
		}
	}
}

// outputName is an output as a problem names it: "2xx", "Unhandled", or its
// status.
func outputName(on int) string {
	switch on {
	case 0:
		return "2xx"
	case OnUnhandled:
		return "Unhandled"
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
