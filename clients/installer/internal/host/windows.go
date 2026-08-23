package host

import (
	"context"
	"fmt"
	"strings"
)

// WindowsPlatform is detection on a Windows host.
//
// The CLASSIFICATION below carries no build tag on purpose: deciding that
// Windows Server is recognised-but-unsupported, or that build 22000 is the
// Windows 11 line, is policy that can be wrong in a damaging way, and policy
// that can only be tested on the machine it describes is policy nobody tests.
// Only the three acquisition calls — version, memory, elevation — sit behind a
// build tag, in windows_native.go.
type WindowsPlatform struct{}

func (WindowsPlatform) GOOS() string { return "windows" }

// Build numbers that mark a product line.
//
// Build number rather than version string, because the version string lies:
// `ProductName` under `Windows NT\CurrentVersion` still reads "Windows 10 …" on
// a Windows 11 machine, kept that way for application compatibility. An
// installer that trusted it would refuse every Windows 11 host in the field
// while reporting a coherent-looking reason. The build number is the only
// field that moved.
const (
	// BuildWindows11 is 21H2, the first Windows 11 build.
	BuildWindows11 = 22000
	// BuildServer2022 and BuildServer2025 are the server lines this installer
	// recognises. Recognising is not supporting — see ClassifyWindows.
	BuildServer2022 = 20348
	BuildServer2025 = 26100
)

// windowsEditions maps the registry's EditionID to what people call it.
//
// EditionID rather than ProductName for the reason above, and because "Core" is
// the registry's name for Home — a mapping nobody guesses right, and getting it
// wrong would silently mark Home hosts as supported.
var windowsEditions = map[string]string{
	"Professional":            "Pro",
	"ProfessionalWorkstation": "Pro for Workstations",
	"Enterprise":              "Enterprise",
	"EnterpriseS":             "Enterprise LTSC",
	"Education":               "Education",
	"Core":                    "Home",
	"CoreN":                   "Home",
	"CoreSingleLanguage":      "Home Single Language",
	"ServerStandard":          "Server Standard",
	"ServerDatacenter":        "Server Datacenter",
}

// supportedClientEditions are the editions the first release targets.
//
// Home is absent deliberately, and not because it cannot work: the brief
// forbids claiming it until Docker Desktop's WSL2 requirements are validated
// there, and an untested claim is worse than an honest refusal.
var supportedClientEditions = map[string]bool{
	"Pro":                  true,
	"Pro for Workstations": true,
	"Enterprise":           true,
	"Enterprise LTSC":      true,
	"Education":            true,
}

// ClassifyWindows turns raw registry facts into a support decision.
//
// `editionID` and `installationType` come from `Windows NT\CurrentVersion`;
// build is `CurrentBuildNumber`; `displayVersion` is the marketing release
// ("23H2") and is cosmetic.
func ClassifyWindows(editionID, installationType string, build int, displayVersion string) OSInfo {
	info := OSInfo{ID: "windows", Build: build}

	edition := windowsEditions[editionID]
	if edition == "" {
		edition = editionID
	}
	info.Edition = edition

	server := strings.EqualFold(installationType, "Server") ||
		strings.HasPrefix(editionID, "Server")

	product := windowsProduct(build, server)
	info.VersionID = displayVersion
	if info.VersionID == "" && build > 0 {
		info.VersionID = fmt.Sprintf("build %d", build)
	}

	info.Name = strings.TrimSpace(product + " " + edition)
	if displayVersion != "" {
		info.Name += " " + displayVersion
	}

	switch {
	case build == 0:
		info.Supported = false
		info.UnsupportedReason = "the Windows build number could not be read"
	case server:
		// Recognised, and deliberately not supported. The brief is explicit:
		// do not claim Windows Server until real end-to-end tests pass, and the
		// open question is whether the selected Docker environment starts
		// unattended without an interactive session.
		info.Supported = false
		info.UnsupportedReason = "Windows Server is recognised but not yet supported — " +
			"unattended Docker startup without an interactive session is untested"
	case build < BuildWindows11:
		info.Supported = false
		info.UnsupportedReason = "Windows 10 and earlier are out of scope for the first release"
	case !supportedClientEditions[edition]:
		info.Supported = false
		info.UnsupportedReason = edition + " is out of scope for the first release — " +
			"Docker Desktop's virtualization requirements are not validated on it"
	default:
		info.Supported = true
	}
	return info
}

// windowsProduct names the product line a build belongs to.
func windowsProduct(build int, server bool) string {
	if server {
		switch {
		case build >= BuildServer2025:
			return "Windows Server 2025"
		case build >= BuildServer2022:
			return "Windows Server 2022"
		default:
			return "Windows Server"
		}
	}
	if build >= BuildWindows11 {
		return "Windows 11"
	}
	if build > 0 {
		return "Windows 10"
	}
	return "Windows"
}

// DetectOS reads the running system's version and classifies it.
func (WindowsPlatform) DetectOS(ReadFileFunc) OSInfo {
	editionID, installationType, build, displayVersion, ok := windowsVersion()
	if !ok {
		return OSInfo{ID: "windows", Name: "Windows",
			UnsupportedReason: "the Windows version could not be read"}
	}
	return ClassifyWindows(editionID, installationType, build, displayVersion)
}

// MemoryBytes reports installed physical memory.
func (WindowsPlatform) MemoryBytes(ReadFileFunc) int64 { return windowsMemoryBytes() }

// DetectPrivileges reports whether this process holds an elevated token.
//
// Group membership is not consulted. Being in Administrators is not the same as
// running elevated — with UAC on, an admin's normal process holds a filtered
// token and cannot write to ProgramData, set an ACL or add a firewall rule. The
// question that matters is what this process can do right now.
func (WindowsPlatform) DetectPrivileges(_ context.Context, _ Runner, _ DockerInfo) UserInfo {
	name, elevated := windowsIdentity()
	return UserInfo{Username: name, Elevated: elevated, UID: -1}
}

// CanInstallDocker gates the Docker Desktop installation path on a supported
// edition. Installing Docker Desktop also needs elevation, which the privilege
// finding reports separately.
func (WindowsPlatform) CanInstallDocker(o OSInfo) bool { return o.Supported }

func (WindowsPlatform) PrivilegeFinding(u UserInfo, d DockerInfo) Finding {
	name := u.Username
	if name == "" {
		name = "current user"
	}
	switch {
	case u.Elevated:
		return Finding{Label: "Administrator", Value: "yes", Level: LevelOK}
	case d.DaemonRunning:
		// Enough to deploy into a Docker that is already running, not enough to
		// install one, protect the .env with an ACL, or add a firewall rule.
		return Finding{Label: "Administrator", Value: "no (" + name + ")", Level: LevelWarn,
			Detail: "Docker is already running, so the stack can be deployed — but " +
				"installing Docker, restricting the configuration file's permissions " +
				"and adding firewall rules all need elevation",
			Remedy: "re-run from an elevated PowerShell (Run as Administrator)"}
	default:
		return Finding{Label: "Administrator", Value: "no (" + name + ")", Level: LevelFail,
			Detail: "installing Docker Desktop, enabling virtualization features, " +
				"creating the installation directory and setting its permissions all need elevation",
			Remedy: "re-run from an elevated PowerShell (Run as Administrator)"}
	}
}

func (WindowsPlatform) Remedy(k RemedyKind) string {
	switch k {
	case RemedyElevate:
		return "re-run from an elevated PowerShell (Run as Administrator)"
	case RemedyStartDocker:
		return "start Docker Desktop and wait for it to report Running — then re-run"
	case RemedyInstallDocker:
		return "install Docker Desktop with the WSL2 backend, then re-run"
	case RemedyInstallCompose:
		// There is no separate plugin to install on Windows: Compose ships
		// inside Docker Desktop, so a missing one means a damaged installation
		// rather than a missing package.
		return "Docker Compose ships with Docker Desktop — repair or update Docker Desktop"
	case RemedyUpgradeDocker:
		return "update Docker Desktop, then re-run"
	case RemedySupportedOS:
		return "supported: Windows 11 Pro, Enterprise and Education. " +
			"Install Docker Desktop yourself and re-run"
	}
	return ""
}
