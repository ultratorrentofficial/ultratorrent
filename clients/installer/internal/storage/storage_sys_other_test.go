//go:build !unix

package storage

// Sys has no ownership to report where the platform cannot answer one.
//
// nil rather than a fabricated value: `statOwner` returns "unknown" for it, the
// ownership finding stays silent, and an advisory that cannot be evaluated is
// silent rather than wrong — the same rule owner_other.go follows.
func (i fakeInfo) Sys() any { return nil }
