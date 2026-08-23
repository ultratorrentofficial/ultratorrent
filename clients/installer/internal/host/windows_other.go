//go:build !windows

package host

import "os/user"

// The non-Windows stand-ins for the three unportable Windows facts.
//
// They exist so `WindowsPlatform` — and every rule in windows.go — compiles and
// is tested from a Linux build. A test that wants a specific Windows host calls
// ClassifyWindows directly with the facts it wants to describe, which is a
// better test than one that could only ever assert what this file returns.

func windowsVersion() (editionID, installationType string, build int, displayVersion string, ok bool) {
	return "", "", 0, "", false
}

func windowsMemoryBytes() int64 { return 0 }

func windowsIdentity() (username string, elevated bool) {
	if u, err := user.Current(); err == nil {
		username = u.Username
	}
	// Never claim elevation off-platform. A false here can only cause an
	// over-cautious finding; a true could let a check pass that should not.
	return username, false
}
