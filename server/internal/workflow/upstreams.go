package workflow

import (
	"fmt"
	"maps"
	"slices"
	"strings"
)

// ValidateUpstream checks one version of an upstream, a saved API endpoint
// and how it's handled (plan 07): its parameters, named as ids are, once
// each, and its request, responses and samples, as an http node's are. It
// reports every problem at once, each pointing into the version.
func ValidateUpstream(u *Upstream) Problems {
	var v validator
	seen := make(map[string]int, len(u.Parameters))
	for k, p := range u.Parameters {
		at := fmt.Sprintf("/parameters/%d/name", k)
		switch j, dup := seen[p.Name]; {
		case p.Name == "":
			v.add(at, "required", "a parameter needs a name")
		case !idPattern.MatchString(p.Name):
			v.add(at, "invalid_name", "%q isn't a valid name: start with a lowercase letter, then use up to 63 lowercase letters, digits or underscores", p.Name)
		case dup:
			v.add(at, "duplicate_parameter", "/parameters/%d is already called %q", j, p.Name)
		default:
			seen[p.Name] = k
		}
		if len(p.Sample) > maxSample {
			v.add(fmt.Sprintf("/parameters/%d/sample", k), "too_large", "a parameter's sample is at most %d KiB; this one is %d KiB", maxSample>>10, kib(len(p.Sample)))
		}
	}
	v.checkRequest("/request", &u.Request)
	v.checkReserved("/request/headers", u.Request.Headers)
	if u.Sample != nil {
		v.checkSample("/sample", u.Sample, false)
	}
	v.checkOutputs("/outputs", u.Outputs)
	return v.problems
}

// checkReserved reports a request header Conduit sets on every call itself:
// W3C trace context, which carries the hop count that stops a workflow
// calling itself (plan 06).
func (v *validator) checkReserved(p string, headers map[string]string) {
	for _, name := range slices.Sorted(maps.Keys(headers)) {
		if strings.EqualFold(name, "traceparent") || strings.EqualFold(name, "tracestate") {
			v.add(p+"/"+PointerToken(name), "reserved_header", "Conduit sets %s on every call, to stop a workflow calling itself for ever", name)
		}
	}
}
