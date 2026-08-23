package host

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// The whole point of the platform seam: these run on the Linux build that
// developers and CI actually use. Not one of them needs a Windows machine,
// because the classification and the findings are plain functions over facts —
// only the three calls that READ those facts are behind a build tag.

func TestClassifyWindowsSupportPolicy(t *testing.T) {
	cases := []struct {
		name             string
		editionID        string
		installationType string
		build            int
		display          string
		wantSupported    bool
		wantReason       string // substring
	}{
		{
			name: "Windows 11 Pro is the target", editionID: "Professional",
			installationType: "Client", build: 22631, display: "23H2",
			wantSupported: true,
		},
		{
			name: "Windows 11 Enterprise is the target", editionID: "Enterprise",
			installationType: "Client", build: 26100, display: "24H2",
			wantSupported: true,
		},
		{
			// "Core" is the registry's name for Home. Anyone reading the raw
			// value would guess "Server Core" and mark it supported.
			name: "Home is refused, not silently accepted", editionID: "Core",
			installationType: "Client", build: 22631,
			wantSupported: false, wantReason: "Home",
		},
		{
			name: "Windows 10 is out of scope", editionID: "Professional",
			installationType: "Client", build: 19045, display: "22H2",
			wantSupported: false, wantReason: "out of scope",
		},
		{
			// The brief is explicit: recognised, and not claimed until tested.
			name: "Server 2022 is recognised but unsupported", editionID: "ServerStandard",
			installationType: "Server", build: 20348,
			wantSupported: false, wantReason: "Windows Server",
		},
		{
			name: "Server 2025 likewise", editionID: "ServerDatacenter",
			installationType: "Server", build: 26100,
			wantSupported: false, wantReason: "Windows Server",
		},
		{
			name: "an unreadable build supports nothing", editionID: "Professional",
			installationType: "Client", build: 0,
			wantSupported: false, wantReason: "build number",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ClassifyWindows(c.editionID, c.installationType, c.build, c.display)
			if got.Supported != c.wantSupported {
				t.Errorf("Supported = %v, want %v (%+v)", got.Supported, c.wantSupported, got)
			}
			if c.wantSupported && got.UnsupportedReason != "" {
				t.Errorf("a supported host carried a reason: %q", got.UnsupportedReason)
			}
			if !c.wantSupported && !strings.Contains(got.UnsupportedReason, c.wantReason) {
				t.Errorf("UnsupportedReason = %q, want it to mention %q",
					got.UnsupportedReason, c.wantReason)
			}
		})
	}
}

// TestWindowsNameIgnoresTheProductNameTrap pins the reason build number is used.
//
// `ProductName` under Windows NT\CurrentVersion still reads "Windows 10 Pro" on
// a Windows 11 machine. An installer that trusted it would refuse every
// Windows 11 host in the field, with a reason that looked entirely coherent.
func TestWindowsNameIgnoresTheProductNameTrap(t *testing.T) {
	got := ClassifyWindows("Professional", "Client", 22631, "23H2")
	if !strings.Contains(got.Name, "Windows 11") {
		t.Errorf("build 22631 must read as Windows 11, got %q", got.Name)
	}
	if strings.Contains(got.Name, "Windows 10") {
		t.Errorf("build 22631 must not read as Windows 10, got %q", got.Name)
	}
	if got.Edition != "Pro" {
		t.Errorf("EditionID Professional should display as Pro, got %q", got.Edition)
	}
	if got.Build != 22631 {
		t.Errorf("Build = %d", got.Build)
	}
}

func TestDefaultPlatformSelectsByGOOS(t *testing.T) {
	if _, ok := DefaultPlatform("windows").(WindowsPlatform); !ok {
		t.Error("windows should select the Windows platform")
	}
	if _, ok := DefaultPlatform("linux").(LinuxPlatform); !ok {
		t.Error("linux should select the Linux platform")
	}
	// Anything else falls back rather than panicking: an unsupported GOOS still
	// deserves a system check that explains itself.
	if _, ok := DefaultPlatform("plan9").(LinuxPlatform); !ok {
		t.Error("an unknown GOOS should fall back to the Linux platform")
	}
}

// fakeWindows is a Windows host whose facts are supplied rather than read.
//
// Embedding WindowsPlatform is deliberate: everything not overridden — the
// remedies, the privilege rendering, CanInstallDocker — is the real
// implementation, so the test exercises shipping code rather than a lookalike.
type fakeWindows struct {
	WindowsPlatform
	os       OSInfo
	elevated bool
}

func (f fakeWindows) DetectOS(ReadFileFunc) OSInfo { return f.os }

func (f fakeWindows) DetectPrivileges(context.Context, Runner, DockerInfo) UserInfo {
	return UserInfo{Username: "ULTRA\\\\admin", Elevated: f.elevated, UID: -1}
}

func (fakeWindows) MemoryBytes(ReadFileFunc) int64 { return 32 << 30 }

func windowsDetector(p Platform, dockerVersion string, portsFree bool) *Detector {
	responses := map[string]string{}
	if dockerVersion != "" {
		responses["docker --version"] = "Docker version " + dockerVersion + ", build x"
		responses["docker version --format {{.Server.Version}}"] = dockerVersion
		responses["docker compose version --short"] = "2.29.1"
	}
	return &Detector{
		Platform:     p,
		Runner:       &fakeRunner{responses: responses},
		ReadFile:     func(string) ([]byte, error) { return nil, errors.New("no such file") },
		LookupPort:   func(int) bool { return portsFree },
		DialRegistry: func(context.Context) bool { return true },
		Statfs:       func(string) (int64, int64, error) { return 180 << 30, 500 << 30, nil },
	}
}

// TestAWindowsHostIsNeverToldToUseSudo is the regression the seam prevents.
//
// The failure it guards is not a crash — it is a system check that fails
// correctly and then tells a Windows administrator to run `sudo systemctl start
// docker`. Shared rules, platform wording.
func TestAWindowsHostIsNeverToldToUseSudo(t *testing.T) {
	plat := fakeWindows{
		os:       ClassifyWindows("Professional", "Client", 22631, "23H2"),
		elevated: true,
	}
	// Docker present but the daemon not answering: the case whose remedy is
	// most obviously platform-specific.
	d := windowsDetector(plat, "", true)
	d.Runner = &fakeRunner{responses: map[string]string{
		"docker --version": "Docker version 27.1.2, build x",
	}}

	r := d.Detect(context.Background(), `C:\ProgramData\UltraTorrent`, nil)
	docker, ok := findingFor(r, "Docker")
	if !ok {
		t.Fatal("no Docker finding")
	}
	if strings.Contains(docker.Remedy, "sudo") || strings.Contains(docker.Remedy, "systemctl") {
		t.Errorf("a Windows host was given a Linux remedy: %q", docker.Remedy)
	}
	if !strings.Contains(docker.Remedy, "Docker Desktop") {
		t.Errorf("Docker remedy = %q, want it to name Docker Desktop", docker.Remedy)
	}

	for _, f := range r.Findings {
		if strings.Contains(f.Remedy, "sudo") || strings.Contains(f.Detail, "/etc/os-release") {
			t.Errorf("Linux wording leaked into a Windows check: %+v", f)
		}
	}
}

func TestWindowsPrivilegeChecksAskAboutElevationNotMembership(t *testing.T) {
	supported := ClassifyWindows("Professional", "Client", 22631, "23H2")

	elevated := windowsDetector(fakeWindows{os: supported, elevated: true}, "27.1.2", true).
		Detect(context.Background(), `C:\ProgramData\UltraTorrent`, nil)
	if f, ok := findingFor(elevated, "Administrator"); !ok || f.Level != LevelOK {
		t.Errorf("an elevated process should pass: %+v", f)
	}

	// Not elevated, but Docker is already running: enough to deploy, not enough
	// to install Docker, set an ACL or add a firewall rule. A warning, not a
	// failure — refusing here would block an install that can genuinely proceed.
	unelevated := windowsDetector(fakeWindows{os: supported, elevated: false}, "27.1.2", true).
		Detect(context.Background(), `C:\ProgramData\UltraTorrent`, nil)
	f, ok := findingFor(unelevated, "Administrator")
	if !ok {
		t.Fatal("no Administrator finding")
	}
	if f.Level != LevelWarn {
		t.Errorf("unelevated with Docker running should warn, got %s", f.Level)
	}
	if unelevated.Blocked() {
		t.Errorf("it must not block: %v", unelevated.Failures())
	}

	// Not elevated and no Docker at all: nothing can be installed.
	nothing := windowsDetector(fakeWindows{os: supported, elevated: false}, "", true).
		Detect(context.Background(), `C:\ProgramData\UltraTorrent`, nil)
	if !nothing.Blocked() {
		t.Error("no elevation and no Docker must block")
	}
}

// TestWindowsServerIsWarnedAboutRatherThanRefused keeps the brief's distinction.
//
// Unsupported means "this installer will not install Docker for you", not "go
// away": a Server host with Docker already running can deploy the stack, and
// the check must say which of the two is true.
func TestWindowsServerIsWarnedAboutRatherThanRefused(t *testing.T) {
	server := ClassifyWindows("ServerStandard", "Server", 20348, "")
	r := windowsDetector(fakeWindows{os: server, elevated: true}, "27.1.2", true).
		Detect(context.Background(), `C:\ProgramData\UltraTorrent`, nil)

	os, ok := findingFor(r, "Operating system")
	if !ok {
		t.Fatal("no OS finding")
	}
	if os.Level != LevelWarn {
		t.Errorf("Server with working Docker should warn, got %s", os.Level)
	}
	if !strings.Contains(os.Detail, "Windows Server") {
		t.Errorf("the reason must survive to the screen, got %q", os.Detail)
	}
	if r.Blocked() {
		t.Errorf("a Server host with Docker running must not be refused: %v", r.Failures())
	}

	// The same host WITHOUT Docker is a failure, because the installer cannot
	// install it there.
	noDocker := windowsDetector(fakeWindows{os: server, elevated: true}, "", true).
		Detect(context.Background(), `C:\ProgramData\UltraTorrent`, nil)
	if !noDocker.Blocked() {
		t.Error("Server without Docker must block — the installer cannot install it there")
	}
}
