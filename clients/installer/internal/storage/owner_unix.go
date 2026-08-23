//go:build unix

package storage

import (
	"io/fs"
	"syscall"
)

func statOwner(info fs.FileInfo) (uid, gid int, ok bool) {
	stat, isUnix := info.Sys().(*syscall.Stat_t)
	if !isUnix {
		return 0, 0, false
	}
	return int(stat.Uid), int(stat.Gid), true
}
