package workflow

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
)

// group is the lines from one block of one node into answers: from node
// from, on output on, a status, 0 for 2xx and a transform's one output, or
// OnUnhandled.
type group struct {
	from, on int
	lines    []lineRef
}

// lineRef is a line into an answer: the answer's place in response.answers,
// and the line's place in its lines.
type lineRef struct{ answer, line int }

// checkResponse checks what the workflow answers. Each answer has a status,
// listed once, and lines into it, each from a node and an output it has, its
// Unhandled block among them. A run answers with the first answer, top to
// bottom, that one of its lines reached (plan 14), so two answers one run
// can reach are no problem; one block joined to two is, as the second is
// never given.
// A definition answers through its response, or, kept for the revisions
// saved with one, its output; not both.
func (v *validator) checkResponse(d *Definition, index map[string]int) {
	r := d.Response
	if r == nil {
		return
	}
	if d.Output != "" {
		v.add("/output", "not_allowed", "a definition with a response has no output: the nodes joined to its answers give them")
	}
	if r.Errors != nil && strings.TrimSpace(r.Errors.Body) == "" {
		v.add("/response/errors/body", "required", "the error body is empty: write one, or remove it to answer errors with problem details")
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
		if len(a.Lines) == 0 {
			v.add(p+"/lines", "required", "join a node to the %d answer", a.Status)
			continue
		}
		for j, l := range a.Lines {
			lp := fmt.Sprintf("%s/lines/%d", p, j)
			from, ok := index[l.From]
			switch {
			case l.From == "":
				v.add(lp+"/from", "required", "a line into the %d answer needs the node it leaves from", a.Status)
				continue
			case !ok:
				v.add(lp+"/from", "unknown_node", "no node has the id %q", l.From)
				continue
			}
			if l.Unhandled && l.On != 0 {
				v.add(lp+"/unhandled", "not_allowed", "a line leaves from one block: %s's %d output or its Unhandled", l.From, l.On)
				continue
			}
			if !v.checkOn(lp+"/on", d.Nodes[from], l.Output(), "a line") {
				continue
			}
			on := l.Output()
			i := slices.IndexFunc(groups, func(g group) bool { return g.from == from && g.on == on })
			if i < 0 {
				groups = append(groups, group{from: from, on: on})
				i = len(groups) - 1
			}
			groups[i].lines = append(groups[i].lines, lineRef{answer: k, line: j})
		}
	}
	for _, g := range groups {
		v.checkGroup(d, g)
	}
}

// checkGroup checks the lines from one block of one node. A run answers with
// the first answer listed that a line reached, so a block joined to two
// answers would never give the second, and a block joined twice to one says
// nothing new. A transform with an expr picks among the answers it's joined
// to, by the status it gives; a case of a switch exits with its own status,
// so it gives the answer of that status.
func (v *validator) checkGroup(d *Definition, g group) {
	n, answers := d.Nodes[g.from], d.Response.Answers
	at := func(r lineRef) string { return fmt.Sprintf("/response/answers/%d/lines/%d/from", r.answer, r.line) }
	cases := n.Kind == NodeKindTransform && n.Switch != nil && g.on != OnUnhandled
	picks := n.Kind == NodeKindTransform && n.Switch == nil && g.on != OnUnhandled
	seen := make(map[int]bool, len(g.lines))
	for _, r := range g.lines {
		status := answers[r.answer].Status
		switch {
		case seen[r.answer]:
			v.add(at(r), "duplicate_line", "%s's %s is joined to the %d answer already", n.ID, outputName(g.on), status)
		case cases && status != g.on:
			v.add(at(r), "other_status", "%s's case giving %d exits with it, so it joins the %d answer", n.ID, g.on, g.on)
		case len(seen) > 0 && !cases && !picks:
			v.add(at(r), "dead_line", "%s's %s gives the %d answer, above, so it never gives %d",
				n.ID, outputName(g.on), answers[g.lines[0].answer].Status, status)
		}
		seen[r.answer] = true
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
