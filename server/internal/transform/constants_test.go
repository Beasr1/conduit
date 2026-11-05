package transform

import (
	"context"
	"errors"
	"slices"
	"testing"
)

// Every expression reads a run's constants as $const.name (plan 06), bound
// when it's evaluated, not put in the data: $ never holds them.
func TestConstants_Read(t *testing.T) {
	ctx := WithConstants(context.Background(), map[string]string{"crm_token": "sk_live_1", "base": "https://crm.example.com"})
	for _, tt := range []struct{ src, want string }{
		{`$const.crm_token`, `"sk_live_1"`},
		{`"Bearer " & $const.crm_token`, `"Bearer sk_live_1"`},
		{`{"token": $const.crm_token, "user": input.user_id}`, `{"token":"sk_live_1","user":"u-42"}`},
		// The data holds no constant.
		{`$keys($)`, `["input","nodes"]`},
	} {
		x, err := Compile(tt.src)
		if err != nil {
			t.Fatal(err)
		}
		got, err := x.Eval(ctx, []byte(doc))
		if err != nil || string(got) != tt.want {
			t.Errorf("%s = %s, %v; want %s", tt.src, got, err, tt.want)
		}
	}
	c, err := CompileCondition(`$const.base = "https://crm.example.com"`)
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := c.Eval(ctx, []byte(doc)); !ok || err != nil {
		t.Errorf("a condition on a constant = %v, %v", ok, err)
	}
	tp, err := CompileTemplate("{{ $const.base }}/v1/contacts?token={{ $const.crm_token }}")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := tp.Render(ctx, []byte(doc), nil); err != nil || got != "https://crm.example.com/v1/contacts?token=sk_live_1" {
		t.Errorf("a template = %q, %v", got, err)
	}

	// Without constants, a read of one gives nothing.
	x, err := Compile(`$const.crm_token`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := x.Eval(context.Background(), []byte(doc)); !errors.Is(err, ErrNoValue) {
		t.Errorf("with no constants: %v, want ErrNoValue", err)
	}
}

// Constants is what an expression reads as $const.name, outside strings,
// comments and backquoted names, which read nothing; and whether it reads
// $const as a whole, which would read every constant at once.
func TestConstants_Found(t *testing.T) {
	for _, tt := range []struct {
		src   string
		names []string
		whole bool
	}{
		{`$const.crm_token`, []string{"crm_token"}, false},
		{`$const.b & $const.a & $const.b`, []string{"a", "b"}, false},
		{`"$const.in_a_string" & '$const.or_this'`, nil, false},
		{`/* $const.in_a_comment */ input.id`, nil, false},
		{`$const.a & "\"$const.escaped\"" & $const.c`, []string{"a", "c"}, false},
		{"`$const.backquoted` & $const.d", []string{"d"}, false},
		{`$constant.x`, nil, false},
		{`$const.Upper_case`, []string{"Upper_case"}, false},
		{`input.id`, nil, false},
		{`$string($const)`, nil, true},
		{`$lookup($const, "crm_token") & $const.a`, []string{"a"}, true},
		{`$const["crm_token"]`, nil, true},
	} {
		x, err := Compile(tt.src)
		if err != nil {
			t.Fatalf("%s: %v", tt.src, err)
		}
		if names, whole := x.Constants(); !slices.Equal(names, tt.names) || whole != tt.whole {
			t.Errorf("Constants(%s) = %q, %v; want %q, %v", tt.src, names, whole, tt.names, tt.whole)
		}
	}
	// An unclosed comment reads nothing past where it starts.
	if names, _ := constantsIn(`$const.a /* $const.b`); !slices.Equal(names, []string{"a"}) {
		t.Errorf("with an unclosed comment: %q", names)
	}
	tp, err := CompileTemplate("https://{{ $const.host }}/{{ input.id }}?k={{ $const.key }}&{{ $const.host }}")
	if err != nil {
		t.Fatal(err)
	}
	if names, whole := tp.Constants(); !slices.Equal(names, []string{"host", "key"}) || whole {
		t.Errorf("a template's constants = %q, %v", names, whole)
	}
	tp, err = CompileTemplate("{{ $string($const) }}")
	if err != nil {
		t.Fatal(err)
	}
	if _, whole := tp.Constants(); !whole {
		t.Error("a template reading $const whole isn't said to")
	}
	c, err := CompileCondition(`$const.on = "yes"`)
	if err != nil {
		t.Fatal(err)
	}
	if names, whole := c.Constants(); !slices.Equal(names, []string{"on"}) || whole {
		t.Errorf("a condition's constants = %q, %v", names, whole)
	}
}

// A read of $const isn't a read of the data, so what an expression reads
// stays a complete answer with one in it.
func TestConstants_ReadsStayComplete(t *testing.T) {
	x, err := Compile(`$const.crm_token & user_id`)
	if err != nil {
		t.Fatal(err)
	}
	paths, complete := x.Reads()
	if !complete || !slices.EqualFunc(paths, [][]string{{"user_id"}}, slices.Equal) {
		t.Errorf("Reads() = %q, %v; want user_id, complete", paths, complete)
	}
	tp, err := CompileTemplate("Bearer {{ $const.crm_token }} {{ usr_id }}")
	if err != nil {
		t.Fatal(err)
	}
	paths, complete = tp.Reads()
	if !complete || !slices.EqualFunc(paths, [][]string{{"usr_id"}}, slices.Equal) {
		t.Errorf("a template's Reads() = %q, %v; want usr_id, complete", paths, complete)
	}
}
