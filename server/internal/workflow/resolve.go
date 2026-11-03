package workflow

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"
)

// Versions is the upstream versions a definition's nodes use, as the
// library has them (plan 07).
type Versions map[Uses]*Upstream

// Revisions is the workflow revisions a definition's nodes use, by the
// workflow and revision each pins, as they were saved (plan 07).
type Revisions map[Uses]*Definition

// Deps is what a definition's nodes use: upstream versions, and workflow
// revisions with what those use in turn, so each of theirs resolves too.
type Deps struct {
	Versions  Versions
	Revisions Revisions
}

// Resolve is d with each node that uses an upstream or a workflow filled
// from what it pins, so the checks an http node gets, and the engine, take
// it as they take any: an upstream's request, responses and samples, or a
// workflow's answers besides 2xx as its responses. It keeps its uses and
// with, which say what it reads: an upstream's request reads the values with
// gives its parameters, and a workflow takes them as its input's fields.
// self is the workflow d is a revision of, which no node may use, directly
// or through others; "" for none. The problems are how nodes use what they
// pin: one deps doesn't have, a value missing or for nothing, a node with a
// request, responses or samples of its own, and a workflow using itself. d
// isn't changed.
func Resolve(d *Definition, deps Deps, self string) (*Definition, Problems) {
	var v validator
	out := *d
	out.Nodes = slices.Clone(d.Nodes)
	for i := range out.Nodes {
		n := &out.Nodes[i]
		p := fmt.Sprintf("/nodes/%d", i)
		switch {
		case n.Uses == nil:
			if n.With != nil {
				v.add(p+"/with", "not_allowed", "only a node that uses an upstream or a workflow gives values to parameters")
			}
		case n.Kind != NodeKindHTTP:
			v.add(p+"/uses", "not_allowed", "only an http node uses an upstream or a workflow")
		case n.Uses.Upstream == "" && n.Uses.Workflow == "":
			v.add(p+"/uses", "required", "name an upstream, with its version, or a workflow, with its revision")
		case n.Uses.Upstream != "" && n.Uses.Workflow != "",
			n.Uses.Upstream != "" && n.Uses.Revision != 0,
			n.Uses.Workflow != "" && n.Uses.Version != 0:
			v.add(p+"/uses", "not_allowed", "a node uses an upstream at a version or a workflow at a revision, not both")
		case n.Uses.Workflow != "":
			v.useWorkflow(n, p, deps.Revisions, self)
		default:
			v.useUpstream(n, p, deps.Versions)
		}
	}
	return &out, v.problems
}

// useUpstream fills node n, at p, from the upstream version it uses: its
// request, responses and samples.
func (v *validator) useUpstream(n *Node, p string, vs Versions) {
	if n.Request != nil {
		v.add(p+"/request", "not_allowed", "a node that uses an upstream sends the upstream's request, so it has none of its own")
	}
	if n.Outputs != nil {
		v.add(p+"/outputs", "not_allowed", "a node that uses an upstream has the upstream's responses, so it lists none of its own")
	}
	if n.Sample != nil {
		v.add(p+"/sample", "not_allowed", "a node that uses an upstream has the upstream's samples, so it has none of its own")
	}
	u, ok := vs[*n.Uses]
	if !ok {
		v.add(p+"/uses", "unknown_upstream", "there's no upstream %s at version %d", n.Uses.Upstream, n.Uses.Version)
		return
	}
	params := make(map[string]bool, len(u.Parameters))
	for _, prm := range u.Parameters {
		params[prm.Name] = true
		if strings.TrimSpace(n.With[prm.Name]) == "" {
			v.add(p+"/with/"+PointerToken(prm.Name), "required", "give the parameter %s a value", prm.Name)
		}
	}
	for _, name := range slices.Sorted(maps.Keys(n.With)) {
		if !params[name] {
			v.add(p+"/with/"+PointerToken(name), "unknown_parameter", "the upstream at version %d has no parameter %s", n.Uses.Version, name)
		}
	}
	req := u.Request
	n.Request, n.Outputs, n.Sample = &req, u.Outputs, u.Sample
}

// useWorkflow fills node n, at p, from the workflow revision it uses: the
// workflow's answers besides 2xx are its responses. Each field of the
// workflow's input is a parameter, the required ones required.
func (v *validator) useWorkflow(n *Node, p string, rs Revisions, self string) {
	if n.Request != nil {
		v.add(p+"/request", "not_allowed", "a node that uses a workflow runs it, so it sends no request of its own")
	}
	if n.Outputs != nil {
		v.add(p+"/outputs", "not_allowed", "a node that uses a workflow has the workflow's answers, so it lists no responses of its own")
	}
	if n.Sample != nil {
		v.add(p+"/sample", "not_allowed", "a node that uses a workflow is previewed by the workflow's own preview, so it has no samples of its own")
	}
	w, ok := rs[*n.Uses]
	if !ok {
		v.add(p+"/uses", "unknown_workflow", "there's no workflow %s at revision %d", n.Uses.Workflow, n.Uses.Revision)
		return
	}
	if self != "" && (n.Uses.Workflow == self || reaches(rs, *n.Uses)[self]) {
		v.add(p+"/uses", "uses_itself", "a workflow can't use itself, directly or through others")
	}
	fields, required := InputOf(w)
	for _, f := range fields {
		if required[f] && strings.TrimSpace(n.With[f]) == "" {
			v.add(p+"/with/"+PointerToken(f), "required", "give the input field %s a value", f)
		}
	}
	for _, name := range slices.Sorted(maps.Keys(n.With)) {
		if !slices.Contains(fields, name) {
			v.add(p+"/with/"+PointerToken(name), "unknown_parameter", "the workflow at revision %d takes no input field %s", n.Uses.Revision, name)
		}
	}
	n.Outputs = AnswersOf(w)
}

// reaches is the workflows the revision u pins uses, directly or through
// others, by id. One rs doesn't have adds nothing: the node that uses it
// says so.
func reaches(rs Revisions, u Uses) map[string]bool {
	out := map[string]bool{}
	seen := map[Uses]bool{}
	var walk func(Uses)
	walk = func(u Uses) {
		if seen[u] {
			return
		}
		seen[u] = true
		for _, n := range rs[u].nodes() {
			if n.Uses != nil && n.Uses.Workflow != "" {
				out[n.Uses.Workflow] = true
				walk(*n.Uses)
			}
		}
	}
	walk(u)
	return out
}

// nodes is d's nodes, none for a nil d.
func (d *Definition) nodes() []Node {
	if d == nil {
		return nil
	}
	return d.Nodes
}

// InputOf is the fields of the input workflow d takes, which a step that
// uses it gives values (plan 07): its input schema's properties, the
// required ones required; with none, its sample input's fields; with
// neither, none. By name.
func InputOf(d *Definition) (fields []string, required map[string]bool) {
	required = map[string]bool{}
	if props, ok := d.InputSchema["properties"].(map[string]any); ok {
		if req, ok := d.InputSchema["required"].([]any); ok {
			for _, r := range req {
				if name, ok := r.(string); ok {
					required[name] = true
				}
			}
		}
		return slices.Sorted(maps.Keys(props)), required
	}
	var sample map[string]json.RawMessage
	if json.Unmarshal(d.SampleInput, &sample) == nil && sample != nil {
		return slices.Sorted(maps.Keys(sample)), required
	}
	return nil, required
}

// AnswersOf is workflow d's answers besides 2xx, each once, in its order:
// the responses of a node that uses it, beside its 2xx.
func AnswersOf(d *Definition) []Output {
	if d.Response == nil {
		return nil
	}
	var out []Output
	for _, a := range d.Response.Answers {
		if a.Status >= 300 && !slices.ContainsFunc(out, func(o Output) bool { return o.Status == a.Status }) {
			out = append(out, Output{Status: a.Status})
		}
	}
	return out
}
