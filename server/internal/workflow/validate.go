// Package workflow owns the workflow definition: its types, generated from
// schema/workflow.yaml, and the structural checks run when one is saved. It
// imports nothing internal and does no I/O. It never sees JSONata: the engine
// compiles expressions and adds its problems to the ones found here.
package workflow

import (
	"fmt"
	"maps"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

// MaxNodes caps a workflow's size; schema/workflow.yaml says the same.
const MaxNodes = 200

const maxTimeoutMS = 300_000

// maxSample caps a sample's body and the sample input, so a definition with
// several stays under the API's 1 MiB request limit.
const maxSample = 64 << 10

// ids are plain identifiers so nodes.<id> works in JSONata without backticks.
var idPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

// Problem is one thing wrong with a definition.
type Problem struct {
	Pointer string // JSON Pointer (RFC 6901) to the field
	Code    string // stable, for programs
	Detail  string // for people
}

// Problems is everything wrong with a definition, in document order. It's an
// error so it can be returned as one.
type Problems []Problem

func (ps Problems) Error() string {
	var b strings.Builder
	b.WriteString("invalid workflow")
	for i, p := range ps {
		if i == 0 {
			b.WriteString(": ")
		} else {
			b.WriteString("; ")
		}
		fmt.Fprintf(&b, "%s: %s", p.Pointer, p.Detail)
	}
	return b.String()
}

// Validate checks a definition's structure: ids, kinds, requests, edges and
// cycles. It reports every problem at once.
func Validate(d *Definition) Problems {
	var v validator
	if len(d.Nodes) > MaxNodes {
		v.add("/nodes", "too_many_nodes", "a workflow has at most %d nodes; this one has %d", MaxNodes, len(d.Nodes))
	}

	index := make(map[string]int, len(d.Nodes))
	for i, n := range d.Nodes {
		p := fmt.Sprintf("/nodes/%d", i)
		switch {
		case n.ID == "":
			v.add(p+"/id", "required", "a node needs an id")
		case !idPattern.MatchString(n.ID):
			v.add(p+"/id", "invalid_id", "%q isn't a valid id: start with a lowercase letter, then use up to 63 lowercase letters, digits or underscores", n.ID)
		}
		if n.ID != "" {
			if j, taken := index[n.ID]; taken {
				v.add(p+"/id", "duplicate_id", "the id %q is already used by /nodes/%d", n.ID, j)
			} else {
				index[n.ID] = i
			}
		}
		v.checkNode(p, n)
	}

	v.checkEdges(d.Edges, d.Nodes, index)
	if len(d.SampleInput) > maxSample {
		v.add("/sample_input", "too_large", "a sample input is at most %d KiB; this one is %d KiB", maxSample>>10, kib(len(d.SampleInput)))
	}
	return v.problems
}

// kib is n bytes in KiB, rounded up, so a cap overrun never reads as the cap.
func kib(n int) int { return (n + 1023) >> 10 }

type validator struct {
	problems Problems
}

func (v *validator) add(pointer, code, format string, args ...any) {
	v.problems = append(v.problems, Problem{Pointer: pointer, Code: code, Detail: fmt.Sprintf(format, args...)})
}

func (v *validator) checkNode(p string, n Node) {
	switch n.Kind {
	case "":
		v.add(p+"/kind", "required", "a node needs a kind: http or transform")
	case NodeKindHTTP:
		if n.Request == nil {
			v.add(p+"/request", "required", "an http node needs a request")
		} else {
			v.checkRequest(p+"/request", n.Request)
		}
		if n.Expr != "" {
			v.add(p+"/expr", "not_allowed", "an http node has a request, not an expr")
		}
	case NodeKindTransform:
		if n.Request != nil {
			v.add(p+"/request", "not_allowed", "a transform node has an expr, not a request")
		}
		if n.Expr == "" {
			v.add(p+"/expr", "required", "a transform node needs an expr")
		}
	default:
		v.add(p+"/kind", "invalid_kind", "the kind %q isn't http or transform", n.Kind)
	}
	switch {
	case n.Sample == nil:
	case n.Kind == NodeKindHTTP:
		v.checkSample(p+"/sample", n.Sample, false)
	case n.Kind == NodeKindTransform:
		v.add(p+"/sample", "not_allowed", "a transform node's value comes from its expr, so it has no sample")
	}
	switch {
	case len(n.Outputs) == 0:
	case n.Kind == NodeKindHTTP:
		v.checkOutputs(p+"/outputs", n.Outputs)
	case n.Kind == NodeKindTransform:
		v.add(p+"/outputs", "not_allowed", "a transform node has one output, so it lists none")
	}
}

// checkOutputs checks an http node's outputs besides 2xx: each a status
// outside 2xx, listed once.
func (v *validator) checkOutputs(p string, outputs []Output) {
	seen := make(map[int]int, len(outputs))
	for j, o := range outputs {
		q := fmt.Sprintf("%s/%d", p, j)
		switch k, dup := seen[o.Status]; {
		case o.Status == 0:
			v.add(q+"/status", "required", "an output needs a status")
		case o.Status < 300 || o.Status > 599:
			v.add(q+"/status", "invalid_status", "an output's status is 300 to 599, as 2xx is every http node's first output; %d isn't", o.Status)
		case dup:
			v.add(q+"/status", "duplicate_output", "%s/%d already has the status %d", p, k, o.Status)
		default:
			seen[o.Status] = j
		}
		if o.Sample != nil {
			v.checkSample(q+"/sample", o.Sample, true)
		}
	}
}

// checkSample checks a sample response: a node's own, which is its 2xx
// answer, or an output's, which takes the output's status.
func (v *validator) checkSample(p string, s *Sample, ofOutput bool) {
	switch {
	case s.Status == 0:
	case ofOutput:
		v.add(p+"/status", "not_allowed", "an output's sample takes the output's status, so it has none of its own")
	case s.Status < 200 || s.Status > 299:
		v.add(p+"/status", "invalid_status", "a node's sample is its 2xx answer, so its status is 200 to 299; %d isn't", s.Status)
	}
	for _, name := range slices.Sorted(maps.Keys(s.Headers)) {
		if !validHeaderName(name) {
			v.add(p+"/headers/"+PointerToken(name), "invalid_header_name", "%q isn't a valid header name", name)
		}
	}
	switch {
	case len(s.Body) == 0:
		v.add(p+"/body", "required", "a sample needs a body; null for none")
	case len(s.Body) > maxSample:
		v.add(p+"/body", "too_large", "a sample's body is at most %d KiB; this one is %d KiB", maxSample>>10, kib(len(s.Body)))
	}
}

func (v *validator) checkRequest(p string, r *HTTPRequest) {
	switch {
	case r.Method == "":
		v.add(p+"/method", "required", "a request needs a method")
	case !r.Method.Valid():
		v.add(p+"/method", "invalid_method", "the method %q isn't one of GET, HEAD, POST, PUT, PATCH or DELETE", r.Method)
	}
	if r.URL == "" {
		v.add(p+"/url", "required", "a request needs a url")
	} else if code, detail := checkURL(r.URL); code != "" {
		v.add(p+"/url", code, "%s", detail)
	}
	for _, name := range slices.Sorted(maps.Keys(r.Headers)) {
		if !validHeaderName(name) {
			v.add(p+"/headers/"+PointerToken(name), "invalid_header_name", "%q isn't a valid header name", name)
		}
	}
	if r.TimeoutMs < 0 || r.TimeoutMs > maxTimeoutMS {
		v.add(p+"/timeout_ms", "invalid_timeout", "timeout_ms is 1 to %d", maxTimeoutMS)
	}
	if r.Retry != nil && (r.Retry.Attempts < 2 || r.Retry.Attempts > 5) {
		v.add(p+"/retry/attempts", "invalid_retry", "attempts is 2 to 5, counting the first")
	}
}

// checkURL returns a problem code and detail, or "" when the url is fine.
// Placeholders may only follow the scheme, host and port, so run input can't
// choose where a request goes.
func checkURL(raw string) (code, detail string) {
	if i := strings.Index(raw, "{{"); i >= 0 {
		if _, rest, ok := strings.Cut(raw[:i], "://"); ok && !strings.ContainsAny(rest, "/?") {
			return "placeholder_in_host", "placeholders can only go in the path and query; the scheme, host and port are fixed when the workflow is saved"
		}
	}
	plain := withoutPlaceholders(raw)
	u, err := url.Parse(plain)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "invalid_url", "the url must be absolute, http or https, with a host"
	}
	if u.User != nil {
		return "invalid_url", "credentials don't belong in a url, where logs and proxies keep them; send them in a header"
	}
	if strings.Contains(plain, "#") {
		return "invalid_url", "a url for an upstream can't have a fragment"
	}
	return "", ""
}

// withoutPlaceholders replaces each {{ … }} with x, so the url around them
// can be parsed. An unclosed placeholder is left alone; compiling the
// template reports it.
func withoutPlaceholders(s string) string {
	var b strings.Builder
	for {
		i := strings.Index(s, "{{")
		if i < 0 {
			break
		}
		j := strings.Index(s[i:], "}}")
		if j < 0 {
			break
		}
		b.WriteString(s[:i])
		b.WriteString("x")
		s = s[i+j+2:]
	}
	b.WriteString(s)
	return b.String()
}

// validHeaderName reports whether s is a token (RFC 9110 §5.6.2).
func validHeaderName(s string) bool {
	if s == "" {
		return false
	}
	for i := range len(s) {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("!#$%&'*+-.^_`|~", c) >= 0 {
			continue
		}
		return false
	}
	return true
}

// PointerToken makes s one JSON Pointer reference token (RFC 6901 §3): ~
// becomes ~0 and / becomes ~1, in that order.
func PointerToken(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "~", "~0"), "/", "~1")
}

// PointerTokens splits a JSON Pointer into its reference tokens, each
// unescaped (RFC 6901 §4): ~1 becomes /, then ~0 becomes ~. The pointer to
// the whole document, "", has none.
func PointerTokens(pointer string) []string {
	if !strings.HasPrefix(pointer, "/") {
		return nil
	}
	tokens := strings.Split(pointer[1:], "/")
	for i, t := range tokens {
		tokens[i] = strings.ReplaceAll(strings.ReplaceAll(t, "~1", "/"), "~0", "~")
	}
	return tokens
}

type edgeRef struct {
	index, from, to int
}

func (v *validator) checkEdges(edges []Edge, nodes []Node, index map[string]int) {
	var good []edgeRef
	// Two nodes are joined at most once per output of the first.
	seen := make(map[[3]int]int, len(edges))
	for k, e := range edges {
		p := fmt.Sprintf("/edges/%d", k)
		from, okFrom := v.endpoint(p+"/from", e.From, index)
		to, okTo := v.endpoint(p+"/to", e.To, index)
		if !okFrom || !okTo {
			continue
		}
		if from == to {
			v.add(p, "self_edge", "a node can't be its own parent")
			continue
		}
		if e.On != 0 {
			switch n := nodes[from]; n.Kind {
			case NodeKindHTTP:
				if !slices.ContainsFunc(n.Outputs, func(o Output) bool { return o.Status == e.On }) {
					v.add(p+"/on", "unknown_output", "%s has no %d output", e.From, e.On)
				}
			case NodeKindTransform:
				v.add(p+"/on", "not_allowed", "a transform node has one output, so an edge from it names none")
			}
		}
		key := [3]int{from, to, e.On}
		if j, dup := seen[key]; dup {
			v.add(p, "duplicate_edge", "/edges/%d already connects %s to %s from the same output", j, e.From, e.To)
			continue
		}
		seen[key] = k
		good = append(good, edgeRef{index: k, from: from, to: to})
	}

	// An edge is on a cycle when both ends are in the same strongly connected
	// component. Edges behind a cycle aren't blamed.
	out := make([][]int, len(nodes))
	for _, e := range good {
		out[e.from] = append(out[e.from], e.to)
	}
	comp := components(out)
	for _, e := range good {
		if comp[e.from] == comp[e.to] {
			v.add(fmt.Sprintf("/edges/%d", e.index), "cycle", "the edge %s → %s is part of a cycle", edges[e.index].From, edges[e.index].To)
		}
	}
}

func (v *validator) endpoint(p, id string, index map[string]int) (int, bool) {
	if id == "" {
		v.add(p, "required", "an edge needs both ends")
		return 0, false
	}
	i, ok := index[id]
	if !ok {
		v.add(p, "unknown_node", "no node has the id %q", id)
	}
	return i, ok
}

// components labels each node with its strongly connected component, using
// Tarjan's algorithm: linear in nodes plus edges, so a dense graph can't make
// saving slow. Recursion depth is at most MaxNodes.
func components(out [][]int) []int {
	n := len(out)
	comp, order, low := make([]int, n), make([]int, n), make([]int, n)
	for i := range n {
		order[i] = -1
	}
	onStack := make([]bool, n)
	var stack []int
	next, label := 0, 0

	var visit func(u int)
	visit = func(u int) {
		order[u], low[u] = next, next
		next++
		stack = append(stack, u)
		onStack[u] = true
		for _, w := range out[u] {
			if order[w] < 0 {
				visit(w)
				low[u] = min(low[u], low[w])
			} else if onStack[w] {
				low[u] = min(low[u], order[w])
			}
		}
		if low[u] == order[u] {
			for {
				w := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				onStack[w] = false
				comp[w] = label
				if w == u {
					break
				}
			}
			label++
		}
	}
	for u := range n {
		if order[u] < 0 {
			visit(u)
		}
	}
	return comp
}
