package transform

import (
	"context"
	"slices"
	"strings"

	"github.com/recolabs/gnata"
)

// Constants (plan 06): every expression reads a run's constants as
// $const.name. They're bound when an expression is evaluated, not put in
// the data, so $ and * never reach one, and what a preview says a step
// reads doesn't hold one.

type constantsKey struct{}

// WithConstants is ctx carrying the values every expression evaluated
// under it reads as $const, by name: a run's, or a preview's stand-ins. It
// travels with the run, as its trace does.
func WithConstants(ctx context.Context, values map[string]string) context.Context {
	consts := make(map[string]any, len(values))
	for name, v := range values {
		consts[name] = v
	}
	return context.WithValue(ctx, constantsKey{}, map[string]any{"const": consts})
}

// StandIn is what a preview gives an expression for a secret constant, and
// what a run keeps or shows in place of one: its name, not its value.
func StandIn(name string) string { return "[secret " + name + "]" }

// varsOf is what ctx binds for gnata: $const, or nothing.
func varsOf(ctx context.Context) map[string]any {
	vars, _ := ctx.Value(constantsKey{}).(map[string]any)
	return vars
}

const constVar = "$const"

// constantsIn is the constants src reads as $const.name, sorted and each
// once, and whether it reads $const as a whole, every constant at once.
// Strings, comments and backquoted names read nothing.
func constantsIn(src string) (names []string, whole bool) {
	at := func(i int) byte {
		if i < len(src) {
			return src[i]
		}
		return 0
	}
	for i := 0; i < len(src); i++ {
		switch c := src[i]; {
		case c == '"' || c == '\'':
			for i++; i < len(src) && src[i] != c; i++ {
				if src[i] == '\\' {
					i++
				}
			}
		case c == '`':
			for i++; i < len(src) && src[i] != '`'; i++ {
			}
		case strings.HasPrefix(src[i:], "/*"):
			end := strings.Index(src[i+2:], "*/")
			if end < 0 {
				return sorted(names), whole
			}
			i += 2 + end + 1
		case strings.HasPrefix(src[i:], constVar) && !nameByte(at(i+len(constVar))):
			j := i + len(constVar)
			k := j + 1
			for at(j) == '.' && nameByte(at(k)) {
				k++
			}
			if k > j+1 {
				names = append(names, src[j+1:k])
				i = k - 1
				continue
			}
			whole = true
			i = j - 1
		}
	}
	return sorted(names), whole
}

func nameByte(b byte) bool {
	return b == '_' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9'
}

func sorted(names []string) []string {
	slices.Sort(names)
	return slices.Compact(names)
}

// analysed is e, compiled from src, for working out what it reads.
// gnata counts a variable it doesn't bind as reading anything, and $const
// is bound only when an expression is evaluated, so src is analysed with
// $const bound first. Never evaluated, so it needs no guardrails.
func analysed(e *gnata.Expression, src string) *gnata.Expression {
	if !strings.Contains(src, constVar) {
		return e
	}
	if bound, err := gnata.Compile("($const := {}; " + src + "\n)"); err == nil {
		return bound
	}
	return e
}

// Constants is what x reads as $const.name, and whether it reads $const
// as a whole.
func (x *Expr) Constants() (names []string, whole bool) { return constantsIn(x.src) }

// Constants is what c reads as $const.name, and whether it reads $const
// as a whole.
func (c *Condition) Constants() (names []string, whole bool) { return constantsIn(c.src) }

// Constants is what t's placeholders read as $const.name, and whether one
// reads $const as a whole.
func (t *Template) Constants() (names []string, whole bool) {
	for _, p := range t.parts {
		if p.e != nil {
			some, all := constantsIn(p.text)
			names, whole = append(names, some...), whole || all
		}
	}
	return sorted(names), whole
}
