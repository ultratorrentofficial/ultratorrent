// Package host inspects the machine the installer is about to change.
//
// Everything here is READ-ONLY. Detection runs before the wizard asks most of
// its questions and again inside `doctor`, and neither may alter the host — so
// the package installs nothing, writes nothing, and starts nothing.
//
// The commands it shells out to and the files it reads are injected, which is
// what makes the interesting logic testable: "does an Ubuntu 24.04 host with
// Docker 19.03 and no Compose plugin produce the right findings" is a table
// test here, not an integration test needing five virtual machines.
package host

import (
	"fmt"
	"strings"
)

// Level is how much a finding matters.
type Level string

const (
	// LevelOK is a satisfied requirement.
	LevelOK Level = "OK"
	// LevelWarn is worth saying and never blocks.
	//
	// Most resource findings are warnings on purpose. The repository documents
	// no minimum RAM, CPU or disk, and the installer must not invent one — a
	// number nobody measured, enforced as a gate, would refuse installations
	// that would have worked perfectly.
	LevelWarn Level = "WARNING"
	// LevelFail is a hard requirement that is not met. The installer stops.
	LevelFail Level = "FAIL"
	// LevelAction is something the installer will do about it, stated before it
	// happens — "Docker: not installed, WILL INSTALL".
	LevelAction Level = "WILL INSTALL"
)

// Finding is one line of the system check.
type Finding struct {
	Label  string
	Value  string
	Level  Level
	// Detail explains a warning or failure in the operator's terms.
	Detail string
	// Remedy is what to do about it, when there is something to do.
	Remedy string
}

// Report is everything detection learned.
type Report struct {
	OS        OSInfo
	Arch      Arch
	User      UserInfo
	Docker    DockerInfo
	Compose   ComposeInfo
	Resources Resources
	Network   NetworkInfo
	Ports     []PortStatus
	Findings  []Finding
}

// OSInfo identifies the distribution.
type OSInfo struct {
	// ID and VersionID come from /etc/os-release: "ubuntu", "24.04".
	ID        string
	VersionID string
	// Name is the pretty name, for display.
	Name string
	// Supported is whether the first release targets this distribution.
	Supported bool
}

// Arch is the CPU architecture, in Go/Docker naming.
type Arch string

const (
	ArchAMD64 Arch = "amd64"
	ArchARM64 Arch = "arm64"
	// ArchOther is anything else. Not refused outright: the failure it would
	// cause is an image that has no matching manifest, and Docker reports that
	// far better than a guess here could.
	ArchOther Arch = "other"
)

// UserInfo is who is running the installer and what they can do.
type UserInfo struct {
	Username string
	UID      int
	IsRoot   bool
	// CanSudo means passwordless sudo answered. A password-prompting sudo is
	// deliberately NOT probed — doing so would hang an unattended run on a
	// prompt nobody is there to answer.
	CanSudo bool
	// InDockerGroup means this user can reach the Docker socket without sudo,
	// which is root-equivalent. Recorded so the installer can say so rather
	// than quietly relying on it.
	InDockerGroup bool
}

// DockerInfo is the engine's state.
type DockerInfo struct {
	Installed bool
	// Version is the server version, e.g. "27.1.2". Empty when the daemon is
	// not reachable, which is a different problem from not installed.
	Version string
	// DaemonRunning distinguishes "docker exists but the daemon is down" from
	// "docker is not installed" — two problems with two different remedies.
	DaemonRunning bool
	MeetsMinimum  bool
}

// ComposeInfo is the Compose plugin's state.
type ComposeInfo struct {
	Installed bool
	Version   string
	// Legacy means the old standalone `docker-compose` (v1, Python) was found
	// instead of the plugin. Reported because it silently lacks `profiles`
	// support that this stack depends on.
	Legacy       bool
	MeetsMinimum bool
}

// Resources is what the machine has.
type Resources struct {
	MemoryBytes int64
	CPUCount    int
	// DiskFreeBytes is free space on the filesystem holding the install
	// directory — not the root disk, which may be a different device.
	DiskFreeBytes  int64
	DiskTotalBytes int64
	DiskPath       string
}

// NetworkInfo is reachability, checked against what the install actually needs.
type NetworkInfo struct {
	Hostname string
	// Addresses are non-loopback IPs, for telling the operator where the UI
	// will be reachable.
	Addresses []string
	// RegistryReachable is whether the Docker registry answered. That is the
	// dependency an install genuinely has; pinging a search engine would test
	// something the installer never uses.
	RegistryReachable bool
	DNSWorks          bool
}

// PortStatus is whether a port the plan wants is free.
type PortStatus struct {
	Port  int
	Label string
	Free  bool
}

// MinDockerVersion is the oldest Docker Engine this stack is known to work on.
//
// Chosen from features the Compose file actually uses rather than from a wish:
// `depends_on: condition: service_healthy` and `profiles` need the Compose
// Specification, which the v2 plugin implements, and 20.10 is the first engine
// series shipped alongside it. Below that the stack does not fail cleanly — it
// starts services in the wrong order and ignores profiles, which looks like an
// application bug.
const MinDockerVersion = "20.10"

// MinComposeVersion is the plugin's floor, for the same reason.
const MinComposeVersion = "2.0"

// Add appends a finding.
func (r *Report) Add(f Finding) { r.Findings = append(r.Findings, f) }

// Blocked reports whether any hard requirement failed.
func (r *Report) Blocked() bool {
	for _, f := range r.Findings {
		if f.Level == LevelFail {
			return true
		}
	}
	return false
}

// Failures and Warnings select findings for display.
func (r *Report) Failures() []Finding { return r.byLevel(LevelFail) }
func (r *Report) Warnings() []Finding { return r.byLevel(LevelWarn) }

func (r *Report) byLevel(level Level) []Finding {
	out := make([]Finding, 0, len(r.Findings))
	for _, f := range r.Findings {
		if f.Level == level {
			out = append(out, f)
		}
	}
	return out
}

// String renders the system check the way the wizard shows it.
func (r *Report) String() string {
	var b strings.Builder
	b.WriteString("\nSystem Check\n\n")
	width := 0
	for _, f := range r.Findings {
		if len(f.Label) > width {
			width = len(f.Label)
		}
	}
	for _, f := range r.Findings {
		fmt.Fprintf(&b, "  %-*s  %-22s %s\n", width, f.Label, f.Value, f.Level)
		if f.Detail != "" {
			fmt.Fprintf(&b, "  %-*s  %s\n", width, "", f.Detail)
		}
		if f.Remedy != "" {
			fmt.Fprintf(&b, "  %-*s  → %s\n", width, "", f.Remedy)
		}
	}
	return b.String()
}

// HumanBytes renders a size the way an operator reads one.
func HumanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit && exp < 4; v /= unit {
		div *= unit
		exp++
	}
	value := float64(n) / float64(div)
	suffix := [...]string{"KB", "MB", "GB", "TB", "PB"}[exp]
	if value < 10 {
		return fmt.Sprintf("%.1f %s", value, suffix)
	}
	return fmt.Sprintf("%.0f %s", value, suffix)
}
