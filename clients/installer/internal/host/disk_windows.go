//go:build windows

package host

import "golang.org/x/sys/windows"

// diskFree reports free and total bytes for the volume holding path.
//
// `GetDiskFreeSpaceExW` rather than the older `GetDiskFreeSpace`: the latter
// reports clusters in 32-bit counts and overflows on any volume a media library
// would plausibly live on.
//
// The first return is the caller-available free space, not the volume's raw
// free space. On a volume with a disk quota those differ, and the number that
// matters is the one this installation may actually use — the same distinction
// `Bavail` draws against `Bfree` on Unix.
func diskFree(path string) (free, total int64, err error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0, err
	}
	var availableToCaller, totalBytes, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(p, &availableToCaller, &totalBytes, &totalFree); err != nil {
		return 0, 0, err
	}
	return int64(availableToCaller), int64(totalBytes), nil
}
