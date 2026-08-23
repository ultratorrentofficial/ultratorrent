//go:build !unix

package storage

// deviceID cannot be answered portably. Reporting "unknown" is correct: the
// same-filesystem check is an advisory, and an advisory that cannot be evaluated
// should be silent rather than guess.
func deviceID(string) (uint64, bool) { return 0, false }
