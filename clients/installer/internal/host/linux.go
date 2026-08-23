package host

import (
	"context"
	"os"
	"os/user"
)

// LinuxPlatform is detection on a Linux host.
//
// Deliberately carries NO build tag. Every fact it gathers comes through an
// injected reader or runner, or through a stdlib call that exists on every
// platform, so these rules compile and are tested from a Windows build too —
// which is the point of the seam. A `//go:build linux` here would make the
// Linux rules untestable from anywhere else, and Windows is a first-class
// target now.
type LinuxPlatform struct{}

func (LinuxPlatform) GOOS() string { return "linux" }

// DetectOS reads /etc/os-release, the interface every modern distribution
// provides.
func (LinuxPlatform) DetectOS(read ReadFileFunc) OSInfo {
	content, _ := read("/etc/os-release")
	return DetectOS(string(content))
}

// MemoryBytes reads /proc/meminfo.
func (LinuxPlatform) MemoryBytes(read ReadFileFunc) int64 {
	meminfo, err := read("/proc/meminfo")
	if err != nil {
		return 0
	}
	total, err := ParseMemTotal(string(meminfo))
	if err != nil {
		return 0
	}
	return total
}

// DetectPrivileges reports root, sudo and docker-group access.
func (LinuxPlatform) DetectPrivileges(ctx context.Context, run Runner, _ DockerInfo) UserInfo {
	info := UserInfo{UID: os.Geteuid()}
	info.IsRoot = info.UID == 0
	info.Elevated = info.IsRoot
	if u, err := user.Current(); err == nil {
		info.Username = u.Username
		if groups, err := u.GroupIds(); err == nil {
			for _, gid := range groups {
				if g, err := user.LookupGroupId(gid); err == nil && g.Name == "docker" {
					info.InDockerGroup = true
				}
			}
		}
	}
	if !info.IsRoot && run != nil {
		// `-n` is essential: without it sudo prompts for a password and an
		// unattended run hangs on a prompt nobody will answer.
		if _, err := run.Run(ctx, "sudo", "-n", "true"); err == nil {
			info.CanSudo = true
			info.Elevated = true
		}
	}
	return info
}

// CanInstallDocker is true for the distributions whose official Docker
// installation path this installer implements.
func (LinuxPlatform) CanInstallDocker(o OSInfo) bool { return o.Supported }

func (LinuxPlatform) PrivilegeFinding(u UserInfo, d DockerInfo) Finding {
	switch {
	case u.IsRoot:
		return Finding{Label: "Privileges", Value: "root", Level: LevelOK}
	case u.CanSudo:
		return Finding{Label: "Privileges", Value: u.Username + " (sudo)", Level: LevelOK}
	case u.InDockerGroup && d.DaemonRunning:
		// Enough to deploy, not enough to install Docker. Said plainly, with the
		// implication stated: docker group membership is root-equivalent, and an
		// operator should know that rather than have the installer rely on it
		// silently.
		return Finding{Label: "Privileges", Value: u.Username + " (docker group)", Level: LevelWarn,
			Detail: "can deploy but cannot install packages; docker group access is " +
				"equivalent to root on this host",
			Remedy: "run with sudo if Docker or directories need to be created"}
	default:
		return Finding{Label: "Privileges", Value: u.Username, Level: LevelFail,
			Detail: "installing Docker, creating directories and managing containers need root",
			Remedy: "re-run with sudo"}
	}
}

func (LinuxPlatform) Remedy(k RemedyKind) string {
	switch k {
	case RemedyElevate:
		return "re-run with sudo"
	case RemedyStartDocker:
		return "sudo systemctl start docker — then re-run"
	case RemedyInstallDocker:
		return "install Docker Engine and the Compose plugin, then re-run"
	case RemedyInstallCompose:
		return "install the Docker Compose plugin (docker-compose-plugin)"
	case RemedyUpgradeDocker:
		return "upgrade Docker Engine, then re-run"
	case RemedySupportedOS:
		return "supported: Ubuntu and Debian. Install Docker yourself and re-run"
	}
	return ""
}
