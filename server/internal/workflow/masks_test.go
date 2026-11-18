package workflow

import (
	"fmt"
	"slices"
	"strings"
	"testing"
)

// A masked field is named as an expression reads one: names and dots, a
// name of other characters in backticks (plan 17).
func TestFieldPath(t *testing.T) {
	t.Parallel()
	for _, tt := range []struct {
		in   string
		want []string
	}{
		{"emirates_id", []string{"emirates_id"}},
		{"customer.emirates_id", []string{"customer", "emirates_id"}},
		{"_id.Phone2", []string{"_id", "Phone2"}},
		{"`first-name`", []string{"first-name"}},
		{"customer.`home address`.line_1", []string{"customer", "home address", "line_1"}},
		{"`a.b`", []string{"a.b"}},
	} {
		got, err := FieldPath(tt.in)
		if err != nil || !slices.Equal(got, tt.want) {
			t.Errorf("FieldPath(%q) = %q, %v; want %q", tt.in, got, err, tt.want)
		}
	}
	for _, in := range []string{
		"", ".", "a.", ".a", "a..b", "first-name", "2fa", "$input", "a b", "`a", "``", "`a`b", "a.`b", "contacts[0].phone", "a.*",
		strings.Repeat("a", 257),
	} {
		if got, err := FieldPath(in); err == nil {
			t.Errorf("FieldPath(%q) = %q, want an error", in, got)
		}
	}
}

// Masks are checked as a version or a revision is saved: a field's name,
// listed once, 1–8 characters kept at an end, and at most 50 fields
// (plan 17).
func TestValidate_Masks(t *testing.T) {
	t.Parallel()
	var many []string
	for i := range 51 {
		many = append(many, fmt.Sprintf(`{"field": "f%d", "mask": {}}`, i))
	}
	upstream := func(params, masked string) string {
		return `{"parameters": [` + params + `], "request": {"method": "GET", "url": "https://x.example.com"}, "masked": [` + masked + `]}`
	}
	tests := []struct {
		name, doc, want string
	}{
		{"all, an end, or both", upstream(`{"name": "a", "mask": {}}, {"name": "b", "mask": {"end": 4}}, {"name": "c", "mask": {"start": 8, "end": 1}}`,
			`{"field": "customer.emirates_id", "mask": {"end": 4}}, {"field": "contacts.phone", "mask": {"start": 3}}`), ""},
		{
			"too many characters kept, or too few", upstream(`{"name": "a", "mask": {"start": 9}}, {"name": "b", "mask": {"end": -1}}`,
				`{"field": "x", "mask": {"start": 0, "end": 9}}`),
			"/masked/0/mask/end invalid_mask\n/parameters/0/mask/start invalid_mask\n/parameters/1/mask/end invalid_mask",
		},
		{
			"a field badly named, or twice", upstream(``, `{"field": "first-name", "mask": {}}, {"field": "a.b", "mask": {}}, {"field": "a.b", "mask": {"end": 2}}`),
			"/masked/0/field invalid_field\n/masked/2/field duplicate_field",
		},
		{"too many fields", upstream(``, strings.Join(many, ", ")), "/masked too_many_fields"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := found(ValidateUpstream(decodeUpstream(t, tt.doc))); got != tt.want {
				t.Errorf("ValidateUpstream() =\n%s\nwant\n%s", got, tt.want)
			}
		})
	}

	d := decode(t, `{"nodes": [{"id": "a", "kind": "transform", "expr": "1"}],
		"masked_input": [{"field": "emirates_id", "mask": {"end": 4}}, {"field": "emirates_id", "mask": {}}, {"field": "a b", "mask": {"start": 10}}]}`)
	want := "/masked_input/1/field duplicate_field\n/masked_input/2/field invalid_field\n/masked_input/2/mask/start invalid_mask"
	if got := found(Validate(d)); got != want {
		t.Errorf("Validate() =\n%s\nwant\n%s", got, want)
	}
}
