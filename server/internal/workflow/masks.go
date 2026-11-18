package workflow

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Masked fields (plan 17): a value marked on an upstream's parameter or
// response, or on a workflow's input, is kept masked wherever a run keeps a
// copy of it. This file names where a field's values are and checks marks
// as they're saved; the runner masks.

const (
	maxMasked     = 50
	maxMaskKept   = 8
	maxFieldBytes = 256
)

// plainName is a field name an expression reads without backticks.
var plainName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// FieldPath is where a masked field's values are: the names in it, in
// order, as an expression reads them, customer.emirates_id, a name of
// other characters in backticks, `first-name`.
func FieldPath(s string) ([]string, error) {
	if len(s) > maxFieldBytes {
		return nil, fmt.Errorf("a field is at most %d characters", maxFieldBytes)
	}
	var names []string
	for rest := s; ; {
		var name string
		if strings.HasPrefix(rest, "`") {
			end := strings.IndexByte(rest[1:], '`')
			if end < 1 {
				return nil, errors.New("a name in backticks needs a closing backtick, and a character between them")
			}
			name, rest = rest[1:1+end], rest[2+end:]
		} else {
			end := strings.IndexByte(rest, '.')
			if end < 0 {
				end = len(rest)
			}
			name, rest = rest[:end], rest[end:]
			if !plainName.MatchString(name) {
				return nil, fmt.Errorf("%q isn't a name: use letters, digits and underscores, starting with a letter or underscore, or put it in backticks", name)
			}
		}
		names = append(names, name)
		if rest == "" {
			return names, nil
		}
		if rest[0] != '.' || len(rest) == 1 {
			return nil, errors.New("put a dot between names, and a name after each dot")
		}
		rest = rest[1:]
	}
}

// checkMask reports a mask that keeps other than 1–8 characters at an end.
func (v *validator) checkMask(p string, m Mask) {
	for _, end := range []struct {
		name string
		kept int
	}{{"start", m.Start}, {"end", m.End}} {
		if end.kept < 0 || end.kept > maxMaskKept {
			v.add(p+"/"+end.name, "invalid_mask", "keep 1 to %d characters at its %s, or none", maxMaskKept, end.name)
		}
	}
}

// checkMasked reports masked fields badly named, listed twice, or too many.
func (v *validator) checkMasked(p string, fields []MaskedField) {
	if len(fields) > maxMasked {
		v.add(p, "too_many_fields", "mask at most %d fields; this has %d", maxMasked, len(fields))
	}
	seen := make(map[string]int, len(fields))
	for k, f := range fields {
		at := fmt.Sprintf("%s/%d", p, k)
		if _, err := FieldPath(f.Field); err != nil {
			v.add(at+"/field", "invalid_field", "%s", err)
		} else if j, dup := seen[f.Field]; dup {
			v.add(at+"/field", "duplicate_field", "%s/%d masks it already", p, j)
		} else {
			seen[f.Field] = k
		}
		v.checkMask(at+"/mask", f.Mask)
	}
}
