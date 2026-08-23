//go:build !unix

package storage

import "io/fs"

// statOwner has no portable answer. Reporting "unknown" keeps the ownership
// check silent rather than wrong where it cannot be evaluated.
func statOwner(fs.FileInfo) (uid, gid int, ok bool) { return 0, 0, false }
