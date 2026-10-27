package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"reflect"
	"slices"
	"strings"

	"github.com/Beasr1/conduit/server/internal/httpapi/gen"
	"github.com/Beasr1/conduit/server/internal/workflow"
)

// bodies is every route that takes a JSON body, with the type it decodes
// into. A test sends each one an unknown field.
var bodies = map[string]reflect.Type{
	"POST /v1/workflows":              reflect.TypeFor[gen.CreateWorkflow](),
	"PUT /v1/workflows/{id}/draft":    reflect.TypeFor[workflow.Definition](),
	"POST /v1/workflows/{id}/publish": reflect.TypeFor[gen.Publish](),
	"POST /v1/validate":               reflect.TypeFor[workflow.Definition](),
	"POST /v1/workflows/{id}/runs":    reflect.TypeFor[gen.StartRun](),
}

// checkShape refuses a body that doesn't fit its route's type: a field the
// type doesn't have, or a value of the wrong JSON type. Every one comes back
// at once, each with its pointer. Left to the generated code, encoding/json
// would drop an unknown field without a word and stop at the first wrong
// type. The types are generated from the schema, so they are its shape.
func checkShape(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t, ok := bodies[r.Pattern]
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeProblem(w, &problem{
					status: http.StatusRequestEntityTooLarge, code: "too_large",
					detail: fmt.Sprintf("The body is over %d bytes.", tooLarge.Limit),
				})
				return
			}
			writeProblem(w, &problem{status: http.StatusBadRequest, code: "invalid_request", detail: "The body couldn't be read."})
			return
		}
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		var v any
		if err := dec.Decode(&v); err != nil {
			writeProblem(w, &problem{status: http.StatusBadRequest, code: "invalid_json", detail: "The body isn't JSON: " + err.Error()})
			return
		}
		var ps []gen.ProblemError
		walk(v, t, "", &ps)
		if len(ps) > 0 {
			writeProblem(w, &problem{
				status: http.StatusUnprocessableEntity, code: "invalid_request",
				detail: "The body doesn't match the API's schema; nothing was saved.", errors: ps,
			})
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		next.ServeHTTP(w, r)
	})
}

var rawJSON = reflect.TypeFor[json.RawMessage]()

// walk checks v, decoded JSON, against t, appending a problem for each
// unknown field and each value of the wrong JSON type.
func walk(v any, t reflect.Type, ptr string, ps *[]gen.ProblemError) {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t == rawJSON || t.Kind() == reflect.Interface {
		return // any JSON at all
	}
	if v == nil { // JSON null
		if t.Kind() != reflect.Map && t.Kind() != reflect.Slice {
			*ps = append(*ps, wrongType(ptr, t, "null"))
		}
		return
	}
	switch t.Kind() {
	case reflect.Struct:
		obj, ok := v.(map[string]any)
		if !ok {
			*ps = append(*ps, wrongType(ptr, t, kindOf(v)))
			return
		}
		fields := jsonFields(t)
		for _, k := range slices.Sorted(maps.Keys(obj)) {
			p := ptr + "/" + workflow.PointerToken(k)
			ft, known := fields[k]
			if !known {
				*ps = append(*ps, gen.ProblemError{Pointer: p, Code: "unknown_field", Detail: fmt.Sprintf("%q isn't a field here", k)})
				continue
			}
			walk(obj[k], ft, p, ps)
		}
	case reflect.Map:
		obj, ok := v.(map[string]any)
		if !ok {
			*ps = append(*ps, wrongType(ptr, t, kindOf(v)))
			return
		}
		for _, k := range slices.Sorted(maps.Keys(obj)) {
			walk(obj[k], t.Elem(), ptr+"/"+workflow.PointerToken(k), ps)
		}
	case reflect.Slice:
		arr, ok := v.([]any)
		if !ok {
			*ps = append(*ps, wrongType(ptr, t, kindOf(v)))
			return
		}
		for i, x := range arr {
			walk(x, t.Elem(), fmt.Sprintf("%s/%d", ptr, i), ps)
		}
	case reflect.String:
		if _, ok := v.(string); !ok {
			*ps = append(*ps, wrongType(ptr, t, kindOf(v)))
		}
	case reflect.Bool:
		if _, ok := v.(bool); !ok {
			*ps = append(*ps, wrongType(ptr, t, kindOf(v)))
		}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		n, ok := v.(json.Number)
		if _, err := n.Int64(); !ok || err != nil {
			*ps = append(*ps, wrongType(ptr, t, kindOf(v)))
		}
	case reflect.Float32, reflect.Float64:
		if _, ok := v.(json.Number); !ok {
			*ps = append(*ps, wrongType(ptr, t, kindOf(v)))
		}
	}
}

// jsonFields maps each JSON field name of struct t to its type.
func jsonFields(t reflect.Type) map[string]reflect.Type {
	fields := make(map[string]reflect.Type, t.NumField())
	for f := range t.Fields() {
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		if !f.IsExported() || name == "-" {
			continue
		}
		if name == "" {
			name = f.Name
		}
		fields[name] = f.Type
	}
	return fields
}

func wrongType(ptr string, want reflect.Type, got string) gen.ProblemError {
	return gen.ProblemError{Pointer: ptr, Code: "invalid_type", Detail: fmt.Sprintf("must be %s, not %s", describe(want), got)}
}

// describe names what JSON a Go type takes.
func describe(t reflect.Type) string {
	switch t.Kind() {
	case reflect.Struct, reflect.Map:
		return "an object"
	case reflect.Slice:
		return "an array"
	case reflect.String:
		return "a string"
	case reflect.Bool:
		return "true or false"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return "a whole number"
	default:
		return "a number"
	}
}

func kindOf(v any) string {
	switch v := v.(type) {
	case map[string]any:
		return "an object"
	case []any:
		return "an array"
	case string:
		return "a string"
	case bool:
		return "a boolean"
	case json.Number:
		if strings.ContainsAny(string(v), ".eE") {
			return "a fraction"
		}
		return "a number"
	default:
		return "null"
	}
}
