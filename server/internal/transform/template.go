package transform

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/recolabs/gnata"
)

// Template is text with {{ expression }} placeholders, such as a URL or a
// header value. A placeholder ends at the first }}, as in Mustache, and there
// is no escape for a literal {{.
type Template struct {
	parts []part
}

type part struct {
	text string            // literal text, or the placeholder's expression
	e    *gnata.Expression // nil for literal text
}

// CompileTemplate compiles src. Each placeholder's value becomes text the way
// $string() does: numbers keep their digits, and objects become JSON.
func CompileTemplate(src string) (*Template, error) {
	var t Template
	rest := src
	for {
		i := strings.Index(rest, "{{")
		if i < 0 {
			if rest != "" {
				t.parts = append(t.parts, part{text: rest})
			}
			return &t, nil
		}
		if i > 0 {
			t.parts = append(t.parts, part{text: rest[:i]})
		}
		j := strings.Index(rest[i+2:], "}}")
		if j < 0 {
			return nil, fmt.Errorf("the {{ at offset %d is never closed", len(src)-len(rest)+i)
		}
		expr := strings.TrimSpace(rest[i+2 : i+2+j])
		if expr == "" {
			return nil, errors.New("a placeholder is empty")
		}
		if _, err := compile(expr); err != nil {
			return nil, fmt.Errorf("{{ %s }}: %w", expr, err)
		}
		e, err := compile("$string(" + expr + ")")
		if err != nil {
			return nil, fmt.Errorf("{{ %s }}: %w", expr, err)
		}
		t.parts = append(t.parts, part{text: expr, e: e})
		rest = rest[i+2+j+2:]
	}
}

// Render evaluates each placeholder over doc and joins the parts. If escape
// isn't nil, each value goes through it with the text rendered so far, so a
// URL can escape a path value differently from a query value.
func (t *Template) Render(ctx context.Context, doc []byte, escape func(prefix, value string) (string, error)) (string, error) {
	var b strings.Builder
	for _, p := range t.parts {
		if p.e == nil {
			b.WriteString(p.text)
			continue
		}
		v, err := p.e.EvalBytes(ctx, doc)
		if err != nil {
			return "", fmt.Errorf("{{ %s }}: %w", p.text, err)
		}
		s, ok := v.(string) // $string gives a string, or nothing for nothing
		if !ok {
			return "", fmt.Errorf("{{ %s }}: %w", p.text, ErrNoValue)
		}
		if escape != nil {
			if s, err = escape(b.String(), s); err != nil {
				return "", fmt.Errorf("{{ %s }}: %w", p.text, err)
			}
		}
		b.WriteString(s)
	}
	return b.String(), nil
}
