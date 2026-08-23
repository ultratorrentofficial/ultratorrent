//go:build windows

package host

import (
	"os/user"
	"strconv"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// The three Windows facts that cannot be obtained portably.
//
// Everything else about Windows detection — which builds are which product,
// which editions are supported, what each remedy says — lives in windows.go
// with no build tag, so it is tested from the Linux build that developers and
// CI actually run. Only these three functions are invisible to that test suite,
// which is why they are kept as small as they can be.

// windowsVersion reads the running system's identity from the registry.
//
// The registry rather than `cmd /c ver` or WMI: no subprocess, no parsing of a
// localized string, and the values are exactly the ones the support policy is
// written against. `ProductName` is deliberately NOT read — it still says
// "Windows 10" on Windows 11.
func windowsVersion() (editionID, installationType string, build int, displayVersion string, ok bool) {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Windows NT\CurrentVersion`, registry.QUERY_VALUE)
	if err != nil {
		return "", "", 0, "", false
	}
	defer key.Close()

	editionID, _, _ = key.GetStringValue("EditionID")
	installationType, _, _ = key.GetStringValue("InstallationType")
	displayVersion, _, _ = key.GetStringValue("DisplayVersion")

	buildText, _, err := key.GetStringValue("CurrentBuildNumber")
	if err == nil {
		build, _ = strconv.Atoi(buildText)
	}
	// A missing build number is the one value with no safe fallback: the whole
	// support policy is written against it, so report failure rather than
	// classify a host as "Windows, build 0" and let the policy guess.
	return editionID, installationType, build, displayVersion, build > 0
}

var (
	kernel32                 = windows.NewLazySystemDLL("kernel32.dll")
	procGlobalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
)

// memoryStatusEx mirrors MEMORYSTATUSEX. Declared here because x/sys/windows
// does not export it.
type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

// windowsMemoryBytes reports installed physical memory.
//
// `Length` must be set before the call — the API uses it to tell struct
// versions apart and fails outright when it is zero, which is the classic way
// this call returns nothing for no visible reason.
func windowsMemoryBytes() int64 {
	var status memoryStatusEx
	status.Length = uint32(unsafe.Sizeof(status))
	ret, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&status)))
	if ret == 0 {
		return 0
	}
	return int64(status.TotalPhys)
}

// windowsIdentity reports the current user and whether this process is elevated.
func windowsIdentity() (username string, elevated bool) {
	if u, err := user.Current(); err == nil {
		username = u.Username
	}
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return username, false
	}
	defer token.Close()
	return username, token.IsElevated()
}
