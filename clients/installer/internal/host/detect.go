package host

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

// Detector gathers a Report. Its dependencies are injected so the logic can be
// tested against any host shape without needing that host.
type Detector struct {
	Runner Runner
	// ReadFile reads a system file. Injected so os-release and meminfo can be
	// faked; defaults to os.ReadFile.
	ReadFile func(string) ([]byte, error)
	// LookupPort reports whether a TCP port is free. Injected for the same
	// reason — a test must not depend on what is listening on the build machine.
	LookupPort func(port int) bool
	// DialRegistry reports whether the Docker registry is reachable.
	DialRegistry func(ctx context.Context) bool
	// Statfs reports free/total bytes for a path.
	Statfs func(path string) (free, total int64, err error)
	// Platform supplies the per-OS half of detection. Injected like everything
	// else here, so a Linux build can exercise the Windows rules: nil means
	// "the platform this binary is running on".
	Platform Platform
}

// plat returns the platform to detect with, defaulting to this binary's own.
func (d *Detector) plat() Platform {
	if d.Platform != nil {
		return d.Platform
	}
	return DefaultPlatform(runtime.GOOS)
}

// NewDetector builds a Detector wired to the real system.
func NewDetector() *Detector {
	return &Detector{
		Runner:       ExecRunner{Timeout: 10 * time.Second},
		ReadFile:     os.ReadFile,
		LookupPort:   PortIsFree,
		DialRegistry: registryReachable,
		Statfs:       diskFree,
		Platform:     DefaultPlatform(runtime.GOOS),
	}
}

// Detect inspects the host and produces findings.
//
// `wantPorts` are the ports the plan intends to publish; passing them in keeps
// the port check honest — it tests what this installation will actually bind
// rather than a hard-coded list that drifts from the plan.
//
// `installDir` decides which filesystem free space is measured on. The root disk
// is the wrong answer when /opt is a separate device, which on a server it often
// is.
func (d *Detector) Detect(ctx context.Context, installDir string, wantPorts []PortStatus) *Report {
	r := &Report{}

	plat := d.plat()

	// --- OS -----------------------------------------------------------------
	r.OS = plat.DetectOS(d.ReadFile)
	r.Arch = DetectArch()

	// --- Docker -------------------------------------------------------------
	//
	// Before privileges, because on Linux "in the docker group with a running
	// daemon" is itself a privilege level and the platform needs to know.
	r.Docker = DetectDocker(ctx, d.Runner)
	r.Compose = DetectCompose(ctx, d.Runner)

	// --- Privileges ---------------------------------------------------------
	r.User = plat.DetectPrivileges(ctx, d.Runner, r.Docker)

	// --- Resources ----------------------------------------------------------
	r.Resources = d.detectResources(installDir)

	// --- Network ------------------------------------------------------------
	r.Network = d.detectNetwork(ctx)

	// --- Ports --------------------------------------------------------------
	for _, want := range wantPorts {
		want.Free = d.LookupPort(want.Port)
		r.Ports = append(r.Ports, want)
	}

	d.evaluate(r)
	return r
}

func (d *Detector) detectResources(installDir string) Resources {
	res := Resources{CPUCount: runtime.NumCPU()}
	res.MemoryBytes = d.plat().MemoryBytes(d.ReadFile)

	// Measure the nearest existing ancestor: the install directory usually does
	// not exist yet, and statfs on a missing path fails. Its parent is on the
	// same filesystem it will be created on, which is the number that matters.
	path := existingAncestor(installDir)
	res.DiskPath = path
	if free, total, err := d.Statfs(path); err == nil {
		res.DiskFreeBytes, res.DiskTotalBytes = free, total
	}
	return res
}

func (d *Detector) detectNetwork(ctx context.Context) NetworkInfo {
	info := NetworkInfo{}
	info.Hostname, _ = os.Hostname()

	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, addr := range addrs {
			ipnet, ok := addr.(*net.IPNet)
			if !ok || ipnet.IP.IsLoopback() || ipnet.IP.To4() == nil {
				continue
			}
			info.Addresses = append(info.Addresses, ipnet.IP.String())
		}
	}

	// DNS and the registry are checked separately because they fail separately:
	// a machine with no DNS and a machine behind a blocking proxy need different
	// fixes, and "no internet" would describe both badly.
	resolver := net.Resolver{}
	dnsCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if _, err := resolver.LookupHost(dnsCtx, "registry-1.docker.io"); err == nil {
		info.DNSWorks = true
	}
	info.RegistryReachable = d.DialRegistry(ctx)
	return info
}

// evaluate turns raw detection into findings an operator can act on.
func (d *Detector) evaluate(r *Report) {
	plat := d.plat()

	// --- Operating system ---------------------------------------------------
	switch {
	case r.OS.ID == "":
		r.Add(Finding{Label: "Operating system", Value: "unknown", Level: LevelWarn,
			Detail: "the operating system could not be identified",
			Remedy: "Docker must already be installed and running on this host"})
	case r.OS.Supported:
		r.Add(Finding{Label: "Operating system", Value: r.OS.Name, Level: LevelOK})
	default:
		// Not fatal on its own. The real requirement is Docker; an unsupported
		// system with Docker already running deploys this stack fine. What it
		// cannot do is have the installer install Docker for it, which the
		// Docker finding below says separately.
		detail := "not a system this installer can install Docker on"
		if r.OS.UnsupportedReason != "" {
			detail = r.OS.UnsupportedReason
		}
		r.Add(Finding{Label: "Operating system", Value: r.OS.Name, Level: LevelWarn,
			Detail: detail, Remedy: plat.Remedy(RemedySupportedOS)})
	}

	// --- Architecture -------------------------------------------------------
	if r.Arch == ArchOther {
		r.Add(Finding{Label: "Architecture", Value: runtime.GOARCH, Level: LevelWarn,
			Detail: "the stack's images are published for amd64 and arm64",
			Remedy: "an image without a matching manifest will fail to pull"})
	} else {
		r.Add(Finding{Label: "Architecture", Value: string(r.Arch), Level: LevelOK})
	}

	// --- Privileges ---------------------------------------------------------
	//
	// The only finding the platform renders whole: root / sudo / docker-group
	// and an elevation token are different enough that one shared switch would
	// be a switch on the platform anyway.
	r.Add(plat.PrivilegeFinding(r.User, r.Docker))

	// --- Docker -------------------------------------------------------------
	canInstall := plat.CanInstallDocker(r.OS)
	switch {
	case !r.Docker.Installed:
		if canInstall {
			r.Add(Finding{Label: "Docker", Value: "not installed", Level: LevelAction})
		} else {
			r.Add(Finding{Label: "Docker", Value: "not installed", Level: LevelFail,
				Detail: "and this installer cannot install it on " + displayOS(r.OS),
				Remedy: plat.Remedy(RemedyInstallDocker)})
		}
	case !r.Docker.DaemonRunning:
		// A different problem from "not installed", with a different fix.
		r.Add(Finding{Label: "Docker", Value: "installed, daemon not responding", Level: LevelFail,
			Detail: "the CLI is present but the daemon did not answer",
			Remedy: plat.Remedy(RemedyStartDocker)})
	case !r.Docker.MeetsMinimum:
		r.Add(Finding{Label: "Docker", Value: r.Docker.Version, Level: LevelFail,
			Detail: fmt.Sprintf("this stack needs Docker %s or newer for health-gated "+
				"startup and Compose profiles", MinDockerVersion),
			Remedy: plat.Remedy(RemedyUpgradeDocker)})
	default:
		r.Add(Finding{Label: "Docker", Value: r.Docker.Version, Level: LevelOK})
	}

	// --- Compose ------------------------------------------------------------
	switch {
	case r.Compose.Legacy:
		r.Add(Finding{Label: "Docker Compose", Value: "v1 (" + r.Compose.Version + ")", Level: LevelFail,
			Detail: "the standalone docker-compose predates the Compose Specification and " +
				"ignores profiles — the stack would start without the engine you selected",
			Remedy: plat.Remedy(RemedyInstallCompose)})
	case !r.Compose.Installed:
		if canInstall {
			r.Add(Finding{Label: "Docker Compose", Value: "not installed", Level: LevelAction})
		} else {
			r.Add(Finding{Label: "Docker Compose", Value: "not installed", Level: LevelFail,
				Remedy: plat.Remedy(RemedyInstallCompose)})
		}
	case !r.Compose.MeetsMinimum:
		r.Add(Finding{Label: "Docker Compose", Value: r.Compose.Version, Level: LevelFail,
			Detail: fmt.Sprintf("this stack needs Compose %s or newer", MinComposeVersion),
			Remedy: "upgrade the Docker Compose plugin"})
	default:
		r.Add(Finding{Label: "Docker Compose", Value: r.Compose.Version, Level: LevelOK})
	}

	// --- Resources ----------------------------------------------------------
	//
	// Every one of these is advisory. The repository documents no minimum RAM,
	// CPU or disk, and the brief forbids inventing one — so these thresholds are
	// labelled as recommendations and never block. They exist to warn someone
	// about to run PostgreSQL, Redis, a torrent engine and a Node backend on a
	// machine that will struggle, not to refuse an installation that might work.
	if r.Resources.MemoryBytes > 0 {
		level, detail := LevelOK, ""
		if r.Resources.MemoryBytes < 2<<30 {
			level = LevelWarn
			detail = "below the 2 GB this installer recommends (not a measured minimum); " +
				"PostgreSQL, Redis, the backend and a torrent engine share this host"
		}
		r.Add(Finding{Label: "Memory", Value: HumanBytes(r.Resources.MemoryBytes), Level: level, Detail: detail})
	}
	if r.Resources.CPUCount > 0 {
		level, detail := LevelOK, ""
		if r.Resources.CPUCount < 2 {
			level = LevelWarn
			detail = "a single CPU will work but indexing and imports will be slow"
		}
		r.Add(Finding{Label: "CPU", Value: fmt.Sprintf("%d core(s)", r.Resources.CPUCount),
			Level: level, Detail: detail})
	}
	if r.Resources.DiskTotalBytes > 0 {
		level, detail := LevelOK, ""
		if r.Resources.DiskFreeBytes < 10<<30 {
			level = LevelWarn
			detail = "the images and database need several GB before any media is downloaded"
		}
		r.Add(Finding{
			Label: "Disk free (" + r.Resources.DiskPath + ")",
			Value: HumanBytes(r.Resources.DiskFreeBytes), Level: level, Detail: detail})
	}

	// --- Network ------------------------------------------------------------
	switch {
	case r.Network.RegistryReachable:
		r.Add(Finding{Label: "Docker registry", Value: "reachable", Level: LevelOK})
	case !r.Network.DNSWorks:
		r.Add(Finding{Label: "Docker registry", Value: "unreachable", Level: LevelFail,
			Detail: "DNS did not resolve registry-1.docker.io",
			Remedy: "fix DNS on this host — images cannot be pulled without it"})
	default:
		r.Add(Finding{Label: "Docker registry", Value: "unreachable", Level: LevelFail,
			Detail: "DNS resolves but the connection did not complete",
			Remedy: "check outbound HTTPS, a firewall, or a proxy that needs configuring"})
	}

	// --- Ports --------------------------------------------------------------
	for _, p := range r.Ports {
		if p.Free {
			r.Add(Finding{Label: fmt.Sprintf("Port %d", p.Port), Value: p.Label, Level: LevelOK})
			continue
		}
		r.Add(Finding{Label: fmt.Sprintf("Port %d", p.Port), Value: "already in use", Level: LevelFail,
			Detail: "wanted for " + p.Label,
			Remedy: "choose a different port, or stop whatever is using this one"})
	}
}

func displayOS(o OSInfo) string {
	if o.Name != "" {
		return o.Name
	}
	return "this system"
}

// existingAncestor walks up until it finds a directory that exists.
//
// The install directory usually does not exist yet, and statfs on a missing path
// fails — but its nearest existing ancestor is on the filesystem it will be
// created on, which is the free space that actually matters.
func existingAncestor(path string) string {
	if path == "" {
		path = "."
	}
	// filepath, not a hand-rolled walk on '/': this measures the filesystem of
	// the machine the installer is running on, so the build target's own path
	// rules are the correct ones — and `C:\ProgramData\UltraTorrent` has no
	// slash to find, so the previous version returned "/" and measured the
	// wrong volume on every Windows host.
	for p := filepath.Clean(path); ; {
		if _, err := os.Stat(p); err == nil {
			return p
		}
		parent := filepath.Dir(p)
		if parent == p {
			// The volume root: "/" on Unix, "C:\" on Windows. Nothing above it.
			return p
		}
		p = parent
	}
}

// PortIsFree reports whether a TCP port can be bound on all interfaces.
//
// Binds rather than connects. A connect-based check reports "free" for a port
// held by a socket that is not accepting, and reports "in use" for one behind a
// firewall — both wrong. Binding asks the only question that matters: can this
// installation publish here.
func PortIsFree(port int) bool {
	l, err := net.Listen("tcp", ":"+strconv.Itoa(port))
	if err != nil {
		return false
	}
	l.Close()
	return true
}

func registryReachable(ctx context.Context) bool {
	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var dialer net.Dialer
	conn, err := dialer.DialContext(dialCtx, "tcp", "registry-1.docker.io:443")
	if err != nil {
		return false
	}
	conn.Close()
	return true
}
