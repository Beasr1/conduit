package workflow

import (
	"fmt"
	"maps"
	"slices"
	"strings"
)

// Versions is the upstream versions a definition's nodes use, as the
// library has them (plan 07).
type Versions map[Uses]*Upstream

// Resolve is d with each node that uses an upstream filled from its
// version: its request, responses and samples, so the checks an http node
// gets, and the engine, take it as they take any. It keeps its uses and
// with, which say its request reads the parameters with gives. The problems
// are how nodes use upstreams: a version vs doesn't have, a parameter with
// no value or a value for no parameter, and a node with a request,
// responses or samples of its own, which are its version's. d isn't
// changed.
func Resolve(d *Definition, vs Versions) (*Definition, Problems) {
	var v validator
	out := *d
	out.Nodes = slices.Clone(d.Nodes)
	for i := range out.Nodes {
		n := &out.Nodes[i]
		p := fmt.Sprintf("/nodes/%d", i)
		switch {
		case n.Uses == nil:
			if n.With != nil {
				v.add(p+"/with", "not_allowed", "only a node that uses an upstream gives values to parameters")
			}
			continue
		case n.Kind != NodeKindHTTP:
			v.add(p+"/uses", "not_allowed", "only an http node uses an upstream")
			continue
		}
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
			continue
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
	return &out, v.problems
}
