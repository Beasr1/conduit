// Package transform evaluates JSONata, the only code users write, through
// gnata. Every expression is compiled with all three guardrails on, and
// evaluated over the run's data document as raw JSON, so 64-bit ids keep
// their digits.
//
// The guardrails bound time and depth, not memory. Measured in plan 02: a
// runaway expression can allocate gigabytes inside the 500 ms timeout, and the
// sequence limit fires only after a cross product is built. The memory
// defence is a process limit, outside this package.
package transform

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/recolabs/gnata"
)

const (
	// A mapping over a 100,000-item response took up to 204 ms, so 500 ms
	// leaves room; an endless loop costs at most this much.
	timeout = 500 * time.Millisecond
	// Lambda calls deep. gnata enforces 100 even when unset.
	stack = 100
	// Items in any sequence built during evaluation, including a path step
	// over the data. Sized to the 10 MiB response cap, which holds about
	// 100,000 small items; 10,000 failed real mappings.
	sequence = 100_000
)

var (
	// ErrNoValue means an expression gave nothing (JSONata's undefined) where
	// a value was needed.
	ErrNoValue = errors.New("the expression gave no value")
	// ErrNotJSON means an expression gave a function, which has no JSON form.
	ErrNotJSON = errors.New("the expression gave a function, which can't be sent as JSON")
)

func compile(src string) (*gnata.Expression, error) {
	return gnata.Compile(src, gnata.WithTimeout(timeout), gnata.WithStack(stack), gnata.WithSequence(sequence))
}

// Expr is a compiled expression whose value is used as JSON: a request body,
// a transform node's result, a run's output.
type Expr struct {
	e *gnata.Expression
}

// Compile compiles a JSONata expression.
func Compile(src string) (*Expr, error) {
	e, err := compile(src)
	if err != nil {
		return nil, err
	}
	return &Expr{e: e}, nil
}

// Eval evaluates x over doc, raw JSON, and returns the value as JSON.
func (x *Expr) Eval(ctx context.Context, doc []byte) (json.RawMessage, error) {
	v, err := x.e.EvalBytes(ctx, doc)
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, ErrNoValue
	}
	if !isJSON(v) {
		return nil, ErrNotJSON
	}
	// An Encoder, because json.Marshal would rewrite <, > and & as < and
	// so on: still JSON, but not the bytes the mapping produced.
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, fmt.Errorf("encode the value: %w", err)
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

// isJSON reports whether v, a gnata result, holds only JSON values. A lambda
// would marshal as a dump of its closure, document included.
func isJSON(v any) bool {
	switch v := v.(type) {
	case nil, bool, string, float64, json.Number, gnata.JSONNull:
		return true
	case []any:
		return allJSON(v)
	case gnata.ConsArray:
		return allJSON(v)
	case map[string]any:
		for _, x := range v {
			if !isJSON(x) {
				return false
			}
		}
		return true
	case *gnata.OrderedMap:
		ok := true
		v.Range(func(_ string, x any) bool {
			ok = isJSON(x)
			return ok
		})
		return ok
	default:
		return false
	}
}

func allJSON(xs []any) bool {
	for _, x := range xs {
		if !isJSON(x) {
			return false
		}
	}
	return true
}

// Condition is a compiled condition, such as an edge's when.
type Condition struct {
	e *gnata.Expression
}

// CompileCondition compiles a JSONata condition. Its value is cast to a
// boolean the way $boolean() does, which is also how JSONata's own ?: and
// filters read conditions.
func CompileCondition(src string) (*Condition, error) {
	if _, err := compile(src); err != nil {
		return nil, err // the error points into src, not the wrapper below
	}
	e, err := compile("$boolean(" + src + ")")
	if err != nil {
		return nil, err
	}
	return &Condition{e: e}, nil
}

// Eval evaluates c over doc. Nothing counts as false.
func (c *Condition) Eval(ctx context.Context, doc []byte) (bool, error) {
	v, err := c.e.EvalBytes(ctx, doc)
	if err != nil {
		return false, err
	}
	b, _ := v.(bool) // $boolean gives a bool, or nothing for nothing
	return b, nil
}
