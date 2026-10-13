package app

import "errors"

// ExitError keeps the machine-facing CLI category attached to an error while
// leaving its human-readable message unchanged.
type ExitError struct {
	Code  int
	Cause error
}

func (e *ExitError) Error() string { return e.Cause.Error() }
func (e *ExitError) Unwrap() error { return e.Cause }

func withExitCode(code int, err error) error {
	if err == nil {
		return nil
	}
	var existing *ExitError
	if errors.As(err, &existing) {
		return err
	}
	return &ExitError{Code: code, Cause: err}
}

// ExitCode reports an explicitly classified CLI error. Unclassified errors
// remain write failures at the command boundary.
func ExitCode(err error) (int, bool) {
	var coded *ExitError
	if !errors.As(err, &coded) || coded == nil || coded.Code < 2 || coded.Code > 7 {
		return 0, false
	}
	return coded.Code, true
}
