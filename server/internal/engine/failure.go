package engine

import (
	"errors"

	"github.com/Beasr1/conduit/server/internal/upstream"
)

// Codes say why a run or a node didn't succeed, and whose fault it was. A
// node whose Unhandled block takes its failure hands its code on, so the
// engine names them.
const (
	CodeUpstream  = "upstream_failed" // an upstream failed: a status, the connection, its body, or a blocked address
	CodeTimeout   = "timeout"         // the run, or a node's last attempt, ran out of time
	CodeWorkflow  = "workflow_error"  // the workflow's own configuration: an expression, a template
	CodeInternal  = "internal_error"  // our bug: details only in the log
	CodeCancelled = "cancelled"       // the caller went away, or the server shut down
)

// Classify says whose fault err, a node's or a run's failure, is.
func Classify(err error) string {
	var ue *upstream.Error
	var pe *PanicError
	switch {
	case errors.As(err, &pe):
		return CodeInternal
	case errors.Is(err, ErrRunTimeout):
		return CodeTimeout
	case errors.As(err, &ue):
		if ue.Kind == upstream.KindTimeout {
			return CodeTimeout
		}
		return CodeUpstream
	default:
		return CodeWorkflow
	}
}
