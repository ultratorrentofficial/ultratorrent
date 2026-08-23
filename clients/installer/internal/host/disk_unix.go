//go:build unix

package host

import "golang.org/x/sys/unix"

// diskFree reports free and total bytes for the filesystem holding path.
//
// Behind a build tag because `unix.Statfs` was, until this phase, the single
// reason this module could not be compiled for Windows at all — two lines in
// three thousand. The rest of the package is GOOS-neutral, so isolating the
// syscall here is what lets `GOOS=windows go build ./...` succeed and every
// shared rule be tested from either platform.
func diskFree(path string) (free, total int64, err error) {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return 0, 0, err
	}
	// Bavail, not Bfree: Bfree counts blocks reserved for root, which an
	// installation running as a normal user cannot actually use.
	return int64(stat.Bavail) * int64(stat.Bsize), int64(stat.Blocks) * int64(stat.Bsize), nil
}
