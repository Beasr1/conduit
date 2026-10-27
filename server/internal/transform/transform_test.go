package transform

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"
)

// doc is a data document as the engine builds it for the spec example's crm
// node: the run input and the finished ancestors.
const doc = `{
  "input": {"user_id": "u-42"},
  "nodes": {
    "user":   {"status": 200, "headers": {"etag": "\"v1\""}, "body": {"id": 12345678901234567890, "email": "ada@example.com", "nick": null}},
    "orders": {"status": 200, "headers": {}, "body": {"items": [{"sku": "a", "price": 2.5}, {"sku": "b", "price": 4}]}},
    "prefs":  {"status": 200, "headers": {}, "body": {"channel": "email", "tags": []}}
  }
}`

func TestExpr_Eval(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, src, want string
	}{
		{
			"spec example: crm body", "{ 'email': nodes.user.body.email, 'orders': $count(nodes.orders.body.items), 'channel': nodes.prefs.body.channel }",
			`{"email":"ada@example.com","orders":2,"channel":"email"}`,
		},
		{"spec example: output", "{ 'user': nodes.user.body.id }", `{"user":12345678901234567890}`},
		{"a 64-bit id keeps its digits", "nodes.user.body.id", `12345678901234567890`},
		{"object keys keep their order", "{ 'b': 1, 'a': 2 }", `{"b":1,"a":2}`},
		{"null is a value", "nodes.user.body.nick", `null`},
		{"arithmetic", "$sum(nodes.orders.body.items.price)", `6.5`},
		{"no HTML escaping", "'<a & b>'", `"<a & b>"`},
		{"an array from a path", "nodes.orders.body.items.sku", `["a","b"]`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			x, err := Compile(tt.src)
			if err != nil {
				t.Fatalf("Compile(%q): %v", tt.src, err)
			}
			got, err := x.Eval(t.Context(), []byte(doc))
			if err != nil {
				t.Fatalf("Eval(%q): %v", tt.src, err)
			}
			if string(got) != tt.want {
				t.Errorf("Eval(%q) = %s, want %s", tt.src, got, tt.want)
			}
		})
	}
}

func TestExpr_EvalRefusesWhatIsntJSON(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, src string
		want      error
	}{
		{"nothing", "nodes.user.body.missing", ErrNoValue},
		{"a function", "function($x) { $x }", ErrNotJSON},
		{"a builtin", "$sum", ErrNotJSON},
		{"a function inside an object", "{ 'f': function() { 1 } }", ErrNotJSON},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			x, err := Compile(tt.src)
			if err != nil {
				t.Fatalf("Compile(%q): %v", tt.src, err)
			}
			if _, err := x.Eval(t.Context(), []byte(doc)); !errors.Is(err, tt.want) {
				t.Errorf("Eval(%q) error = %v, want %v", tt.src, err, tt.want)
			}
		})
	}
}

func TestCompile_RejectsBadSyntax(t *testing.T) {
	t.Parallel()
	for _, src := range []string{"nodes.user.", "{", "$count(", ""} {
		if _, err := Compile(src); err == nil {
			t.Errorf("Compile(%q) succeeded, want an error", src)
		}
	}
}

func TestCondition_Eval(t *testing.T) {
	t.Parallel()
	tests := []struct {
		src  string
		want bool
	}{
		{"nodes.user.status = 200", true},
		{"nodes.user.status = 404", false},
		{"nodes.user.body.missing", false}, // nothing is false
		{"nodes.user.body.nick", false},    // null is false
		{"nodes.prefs.body.tags", false},   // an empty array is false
		{"nodes.orders.body.items", true},  // a non-empty array is true
		{"nodes.prefs.body.channel", true}, // a non-empty string is true
		{"$count(nodes.orders.body.items) > 1", true},
	}
	for _, tt := range tests {
		t.Run(tt.src, func(t *testing.T) {
			t.Parallel()
			c, err := CompileCondition(tt.src)
			if err != nil {
				t.Fatalf("CompileCondition(%q): %v", tt.src, err)
			}
			got, err := c.Eval(t.Context(), []byte(doc))
			if err != nil {
				t.Fatalf("Eval(%q): %v", tt.src, err)
			}
			if got != tt.want {
				t.Errorf("Eval(%q) = %v, want %v", tt.src, got, tt.want)
			}
		})
	}
}

func TestTemplate_Render(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, src, want string
	}{
		{"no placeholders", "application/json", "application/json"},
		{"spec example: user url", "https://users.example.com/v1/users/{{ input.user_id }}", "https://users.example.com/v1/users/u-42"},
		{"a 64-bit id keeps its digits", "/orders?user={{nodes.user.body.id}}", "/orders?user=12345678901234567890"},
		{"computed numbers", "{{ $count(nodes.orders.body.items) }} items", "2 items"},
		{"null becomes null", "nick={{ nodes.user.body.nick }}", "nick=null"},
		{"an object becomes JSON", "{{ nodes.prefs.body }}", `{"channel":"email","tags":[]}`},
		{"the first }} closes", "{{ 'x' }}}}", "x}}"},
		{"two placeholders", "{{ input.user_id }}-{{ nodes.prefs.body.channel }}", "u-42-email"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			tpl, err := CompileTemplate(tt.src)
			if err != nil {
				t.Fatalf("CompileTemplate(%q): %v", tt.src, err)
			}
			got, err := tpl.Render(t.Context(), []byte(doc), nil)
			if err != nil {
				t.Fatalf("Render(%q): %v", tt.src, err)
			}
			if got != tt.want {
				t.Errorf("Render(%q) = %q, want %q", tt.src, got, tt.want)
			}
		})
	}
}

func TestTemplate_RenderPassesEachValueToEscape(t *testing.T) {
	t.Parallel()
	tpl, err := CompileTemplate("https://x.example/a/{{ input.user_id }}?q={{ nodes.prefs.body.channel }}")
	if err != nil {
		t.Fatal(err)
	}
	var prefixes []string
	got, err := tpl.Render(t.Context(), []byte(doc), func(prefix, v string) (string, error) {
		prefixes = append(prefixes, prefix)
		return url.QueryEscape("<" + v + ">"), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := "https://x.example/a/%3Cu-42%3E?q=%3Cemail%3E"; got != want {
		t.Errorf("Render() = %q, want %q", got, want)
	}
	if want := "https://x.example/a/|https://x.example/a/%3Cu-42%3E?q="; strings.Join(prefixes, "|") != want {
		t.Errorf("escape saw prefixes %q, want %q", strings.Join(prefixes, "|"), want)
	}
}

func TestTemplate_RenderFailsOnNothing(t *testing.T) {
	t.Parallel()
	tpl, err := CompileTemplate("/users/{{ input.missing }}")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tpl.Render(t.Context(), []byte(doc), nil); !errors.Is(err, ErrNoValue) {
		t.Errorf("Render() error = %v, want ErrNoValue", err)
	}
}

func TestCompileTemplate_RejectsBadPlaceholders(t *testing.T) {
	t.Parallel()
	for _, src := range []string{"/users/{{ input.id", "/users/{{ }}", "/users/{{ input. }}"} {
		if _, err := CompileTemplate(src); err == nil {
			t.Errorf("CompileTemplate(%q) succeeded, want an error", src)
		}
	}
}

// The guardrails stop runaway expressions. Each case names the JSONata error
// code it expects.
func TestGuardrails(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, src, code string
	}{
		{"deep recursion", "($f := function($n) { $n = 0 ? 0 : 1 + $f($n - 1) }; $f(1000))", "D1011"},
		{"endless tail recursion", "($inf := function() { $inf() }; $inf())", "D1012"},
		{"a range past the sequence limit", "$count([1..200000])", "D2015"},
		// Just past the limit, at 102,400 items: the product is built before
		// the limit is checked, so a bigger one can reach the timeout first on
		// a slow machine. A million items did, in CI under -race.
		{"a cross product past the sequence limit", "$count([1..320].([1..320]))", "D2015"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			x, err := Compile(tt.src)
			if err != nil {
				t.Fatalf("Compile(%q): %v", tt.src, err)
			}
			start := time.Now()
			_, err = x.Eval(t.Context(), []byte(`{}`))
			if err == nil || !strings.Contains(err.Error(), tt.code) {
				t.Fatalf("Eval(%q) error = %v, want %s", tt.src, err, tt.code)
			}
			if elapsed := time.Since(start); elapsed > 2*time.Second {
				t.Errorf("Eval(%q) took %v; the guardrail fired late", tt.src, elapsed)
			}
		})
	}
}

func TestEval_StopsWhenContextIsCancelled(t *testing.T) {
	t.Parallel()
	x, err := Compile("($inf := function() { $inf() }; $inf())")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := x.Eval(ctx, []byte(`{}`)); err == nil {
		t.Fatal("Eval() succeeded, want an error")
	}
	if elapsed := time.Since(start); elapsed > 300*time.Millisecond {
		t.Errorf("Eval() took %v after its context ended, want well under the 500 ms guardrail", elapsed)
	}
}
