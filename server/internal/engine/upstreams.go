package engine

import (
	"fmt"

	"github.com/Beasr1/conduit/server/internal/workflow"
)

// reader is a compiled expression or template, which says what it reads.
type reader interface {
	Reads() (paths [][]string, complete bool)
}

// CheckUpstream checks one version of an upstream (plan 07): what
// workflow.ValidateUpstream does, that every expression in its request
// compiles, and that each reads only the upstream's parameters, by name.
// One that may read what it doesn't name, the whole input say, is left to
// run time.
func CheckUpstream(u *workflow.Upstream) workflow.Problems {
	c := compiler{problems: workflow.ValidateUpstream(u)}
	params := make(map[string]bool, len(u.Parameters))
	for _, p := range u.Parameters {
		params[p.Name] = true
	}
	reads := func(pointer string, r reader) {
		paths, complete := r.Reads()
		if !complete {
			return
		}
		for _, path := range paths {
			if !params[path[0]] { // a complete read names each path from a field
				c.problems = append(c.problems, workflow.Problem{
					Pointer: pointer, Code: "unknown_parameter",
					Detail: fmt.Sprintf("it reads %s, which isn't one of the upstream's parameters: add it, or fix the name", path[0]),
				})
			}
		}
	}
	r := u.Request
	if t := c.template("/request/url", r.URL); t != nil {
		reads("/request/url", t)
	}
	for _, at := range []struct {
		pointer string
		m       map[string]string
	}{{"/request/headers", r.Headers}, {"/request/query", r.Query}} {
		for _, p := range c.params(at.pointer, at.m) {
			if p.value != nil {
				reads(at.pointer+"/"+workflow.PointerToken(p.name), p.value)
			}
		}
	}
	if r.Body != "" {
		if x := c.expr("/request/body", r.Body); x != nil {
			reads("/request/body", x)
		}
	}
	return c.problems
}
