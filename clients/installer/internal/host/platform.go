package host

import "context"

// The platform seam.
//
// Almost all of host detection is the same question on every operating system:
// is Docker new enough, is the Compose plugin the v2 one, is this port free, is
// the registry reachable, is there enough disk. Those rules live in evaluate()
// and are written once.
//
// What genuinely differs is narrower than it looks, and it is exactly two
// things: how a fact is ACQUIRED (an os-release file against a registry key; a
// uid against an elevation token) and how a remedy is WORDED ("re-run with
// sudo" against "re-run as Administrator"). This interface covers those two and
// nothing else — a second evaluate() would be the beginning of two installers.
//
// Implementations are deliberately STATELESS, taking their dependencies as
// arguments. That keeps construction trivial and, more usefully, keeps the
// Windows rules testable from a Linux build: the interesting logic lives in
// plain functions in windows.go with no build tag, and only the syscalls sit
// behind one.

// ReadFileFunc reads a system file. Injected so detection can be faked.
type ReadFileFunc func(string) ([]byte, error)

// RemedyKind names a remedy whose rule is shared but whose wording is not.
type RemedyKind int

const (
	// RemedyElevate is how to re-run with the privileges this install needs.
	RemedyElevate RemedyKind = iota
	// RemedyStartDocker is how to start a Docker that is installed but not
	// answering.
	RemedyStartDocker
	// RemedyInstallDocker is what to do when the installer cannot install
	// Docker on this host itself.
	RemedyInstallDocker
	// RemedyInstallCompose is the same for the Compose plugin.
	RemedyInstallCompose
	// RemedyUpgradeDocker is how to move off a too-old engine.
	RemedyUpgradeDocker
	// RemedySupportedOS names what this installer can install Docker on.
	RemedySupportedOS
)

// Platform is the per-operating-system half of detection.
type Platform interface {
	// GOOS is the Go name for this platform: "linux", "windows".
	GOOS() string

	// DetectOS identifies the operating system and decides whether this
	// installer supports it.
	DetectOS(read ReadFileFunc) OSInfo

	// DetectPrivileges reports what the running process may do. Docker state is
	// passed in because on Linux "in the docker group with a live daemon" is a
	// meaningful privilege level and on Windows it is not.
	DetectPrivileges(ctx context.Context, run Runner, docker DockerInfo) UserInfo

	// MemoryBytes is total physical memory, or 0 when it cannot be determined.
	MemoryBytes(read ReadFileFunc) int64

	// CanInstallDocker reports whether the installer can install Docker on this
	// OS itself. False is not a failure by itself — a host with Docker already
	// running deploys the stack fine — it only decides whether a missing Docker
	// is an action or a blocker.
	CanInstallDocker(OSInfo) bool

	// PrivilegeFinding renders the privilege check.
	//
	// Platform-shaped because the concepts genuinely differ: root, passwordless
	// sudo and docker-group membership against a process elevation token. The
	// shared code decides that privileges MATTER; the platform decides what
	// having them looks like.
	PrivilegeFinding(UserInfo, DockerInfo) Finding

	// Remedy renders one shared rule's advice in this platform's terms.
	Remedy(RemedyKind) string
}

// DefaultPlatform returns the platform for the machine this binary is running
// on. Selected at runtime rather than by build tag so a build for one OS can
// still exercise the other's rules in tests.
func DefaultPlatform(goos string) Platform {
	switch goos {
	case "windows":
		return WindowsPlatform{}
	default:
		return LinuxPlatform{}
	}
}
