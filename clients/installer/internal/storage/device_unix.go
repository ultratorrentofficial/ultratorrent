//go:build unix

package storage

import "syscall"

// deviceID returns the filesystem device a path lives on.
//
// Kept behind a build tag deliberately. The only other non-portable code in this
// module is `unix.Statfs` in host detection, and a parallel audit found that one
// line is what stops the whole package compiling for Windows. Adding a second
// unguarded syscall would deepen that; this way the core stays GOOS-neutral and
// the check simply reports "unknown" where it cannot be answered.
func deviceID(path string) (uint64, bool) {
	var stat syscall.Stat_t
	if err := syscall.Stat(path, &stat); err != nil {
		return 0, false
	}
	return uint64(stat.Dev), true
}
