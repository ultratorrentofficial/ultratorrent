package host

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// --- os-release parsing ----------------------------------------------------

func TestParseOSRelease(t *testing.T) {
	const ubuntu = `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
ID=ubuntu
ID_LIKE=debian
# a comment
HOME_URL="https://www.ubuntu.com/"`

	got := ParseOSRelease(ubuntu)
	if got["ID"] != "ubuntu" || got["VERSION_ID"] != "24.04" {
		t.Fatalf("parsed = %v", got)
	}
	if got["PRETTY_NAME"] != "Ubuntu 24.04.1 LTS" {
		t.Errorf("quotes should be stripped, got %q", got["PRETTY_NAME"])
	}
	if _, present := got["# a comment"]; present {
		t.Error("comments must be skipped")
	}
}

func TestParseOSReleaseKeepsAnApostrophe(t *testing.T) {
	// Only a MATCHED pair of quotes is stripped, so an apostrophe inside a name
	// survives instead of eating the last character.
	got := ParseOSRelease(`PRETTY_NAME="Bob's Linux"`)
	if got["PRETTY_NAME"] != "Bob's Linux" {
		t.Errorf("got %q", got["PRETTY_NAME"])
	}
}

func TestDetectOSSupportPolicy(t *testing.T) {
	cases := []struct {
		name      string
		content   string
		wantID    string
		supported bool
	}{
		{"ubuntu", "ID=ubuntu\nVERSION_ID=\"24.04\"", "ubuntu", true},
		{"debian", "ID=debian\nVERSION_ID=\"12\"", "debian", true},
		// A derivative is treated as its base, because that is what governs how
		// Docker is installed.
		{"linux mint", "ID=linuxmint\nID_LIKE=ubuntu", "linuxmint", true},
		{"raspberry pi os", "ID=raspbian\nID_LIKE=debian", "raspbian", true},
		{"fedora", "ID=fedora\nVERSION_ID=40", "fedora", false},
		{"arch", "ID=arch", "arch", false},
		{"empty", "", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := DetectOS(c.content)
			if got.ID != c.wantID {
				t.Errorf("ID = %q, want %q", got.ID, c.wantID)
			}
			if got.Supported != c.supported {
				t.Errorf("Supported = %v, want %v", got.Supported, c.supported)
			}
		})
	}
}

// --- memory ----------------------------------------------------------------

func TestParseMemTotalUsesKibibytes(t *testing.T) {
	/*
	 * /proc/meminfo says "kB" and means kibibytes — a long-standing Linux quirk.
	 * Using 1000 here would under-report every machine by 2.4%, which is exactly
	 * the kind of quiet wrongness that survives review.
	 */
	got, err := ParseMemTotal("MemTotal:       16384000 kB\nMemFree: 100 kB")
	if err != nil {
		t.Fatal(err)
	}
	if want := int64(16384000) * 1024; got != want {
		t.Errorf("MemTotal = %d, want %d", got, want)
	}
}

func TestParseMemTotalReportsMissingData(t *testing.T) {
	// Silently returning 0 would render as "Memory 0 B" and look like a broken
	// machine rather than a failed read.
	if _, err := ParseMemTotal("MemFree: 100 kB"); err == nil {
		t.Error("expected an error when MemTotal is absent")
	}
	if _, err := ParseMemTotal("MemTotal: notanumber kB"); err == nil {
		t.Error("expected an error for an unparseable value")
	}
}

// --- version comparison ----------------------------------------------------

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"27.1.2", "20.10", 1},
		{"20.10", "20.10", 0},
		{"19.03.15", "20.10", -1},
		{"2.29.1", "2.0", 1},
		{"1.29.2", "2.0", -1},
		// Docker's real-world versions are not clean semver. The distribution
		// suffix must not break parsing — and 20.10.7 is genuinely NEWER than
		// 20.10, so the patch component still counts.
		{"20.10.7-0ubuntu1", "20.10", 1},
		// The suffix alone, with nothing after it, compares equal.
		{"20.10-0ubuntu1", "20.10", 0},
		{"20.09.9", "20.10", -1},
		{"v2.24.5", "2.0", 1},
		{"24", "20.10", 1},
	}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("compare(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestAtLeastRejectsAnUnknownVersion(t *testing.T) {
	// An empty version means the daemon never answered; treating that as "new
	// enough" would let the installer proceed against a Docker it never saw.
	if AtLeast("", MinDockerVersion) {
		t.Error("an unknown version must not satisfy a minimum")
	}
}

// --- Docker / Compose detection --------------------------------------------

// fakeRunner answers a scripted set of commands.
type fakeRunner struct {
	responses map[string]string
	errs      map[string]error
	calls     []string
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) (string, error) {
	key := strings.TrimSpace(name + " " + strings.Join(args, " "))
	f.calls = append(f.calls, key)
	if err, ok := f.errs[key]; ok {
		return "", err
	}
	if out, ok := f.responses[key]; ok {
		return out, nil
	}
	return "", errors.New("command not found: " + key)
}

func TestDetectDockerDistinguishesThreeFailures(t *testing.T) {
	/*
	 * Not installed, daemon down, and too old are three problems with three
	 * different remedies. Collapsing them into "Docker: no" would send someone
	 * to reinstall something that needed `systemctl start`.
	 */
	t.Run("not installed", func(t *testing.T) {
		got := DetectDocker(context.Background(), &fakeRunner{})
		if got.Installed || got.DaemonRunning {
			t.Errorf("got %+v", got)
		}
	})

	t.Run("installed, daemon down", func(t *testing.T) {
		r := &fakeRunner{
			responses: map[string]string{"docker --version": "Docker version 27.1.2, build abc"},
			errs: map[string]error{
				"docker version --format {{.Server.Version}}": errors.New("cannot connect"),
			},
		}
		got := DetectDocker(context.Background(), r)
		if !got.Installed {
			t.Error("the CLI is present, so Installed should be true")
		}
		if got.DaemonRunning {
			t.Error("the daemon did not answer, so DaemonRunning should be false")
		}
	})

	t.Run("running but too old", func(t *testing.T) {
		r := &fakeRunner{responses: map[string]string{
			"docker --version": "Docker version 19.03.15, build x",
			"docker version --format {{.Server.Version}}": "19.03.15",
		}}
		got := DetectDocker(context.Background(), r)
		if !got.DaemonRunning {
			t.Fatal("daemon should be seen as running")
		}
		if got.MeetsMinimum {
			t.Errorf("19.03.15 must not satisfy the %s minimum", MinDockerVersion)
		}
	})

	t.Run("healthy", func(t *testing.T) {
		r := &fakeRunner{responses: map[string]string{
			"docker --version": "Docker version 27.1.2, build x",
			"docker version --format {{.Server.Version}}": "27.1.2",
		}}
		got := DetectDocker(context.Background(), r)
		if !got.MeetsMinimum || got.Version != "27.1.2" {
			t.Errorf("got %+v", got)
		}
	})
}

func TestDetectComposeRejectsTheLegacyBinary(t *testing.T) {
	/*
	 * v1 is not "an older Compose that mostly works" — it predates the Compose
	 * Specification and ignores `profiles` entirely. A stack deployed with it
	 * comes up with no torrent engine and no error explaining why.
	 */
	r := &fakeRunner{responses: map[string]string{
		"docker-compose --version": "docker-compose version 1.29.2, build 5becea4c",
	}}
	got := DetectCompose(context.Background(), r)
	if !got.Legacy {
		t.Fatal("the standalone v1 binary should be reported as legacy")
	}
	if got.MeetsMinimum {
		t.Error("legacy Compose must never satisfy the minimum")
	}
	if got.Version != "1.29.2" {
		t.Errorf("version extracted = %q", got.Version)
	}
}

func TestDetectComposePrefersThePlugin(t *testing.T) {
	r := &fakeRunner{responses: map[string]string{
		"docker compose version --short": "2.29.1",
		// Present too; the plugin must win.
		"docker-compose --version": "docker-compose version 1.29.2, build x",
	}}
	got := DetectCompose(context.Background(), r)
	if got.Legacy {
		t.Error("the plugin should be preferred over the legacy binary")
	}
	if !got.MeetsMinimum || got.Version != "2.29.1" {
		t.Errorf("got %+v", got)
	}
}

// --- evaluation ------------------------------------------------------------

// detectorFor builds a Detector with everything faked.
func detectorFor(osRelease string, r Runner, portsFree bool, registry bool) *Detector {
	return &Detector{
		Runner: r,
		ReadFile: func(name string) ([]byte, error) {
			switch name {
			case "/etc/os-release":
				return []byte(osRelease), nil
			case "/proc/meminfo":
				return []byte("MemTotal:       16384000 kB"), nil
			}
			return nil, errors.New("no such file")
		},
		LookupPort:   func(int) bool { return portsFree },
		DialRegistry: func(context.Context) bool { return registry },
		Statfs: func(string) (int64, int64, error) {
			return 80 << 30, 200 << 30, nil // 80 GB free of 200
		},
	}
}

func healthyDocker() *fakeRunner {
	return &fakeRunner{responses: map[string]string{
		"docker --version": "Docker version 27.1.2, build x",
		"docker version --format {{.Server.Version}}": "27.1.2",
		"docker compose version --short":              "2.29.1",
		"sudo -n true":                                "",
	}}
}

func findingFor(r *Report, label string) (Finding, bool) {
	for _, f := range r.Findings {
		if strings.HasPrefix(f.Label, label) {
			return f, true
		}
	}
	return Finding{}, false
}

func TestHealthyUbuntuHostPasses(t *testing.T) {
	d := detectorFor("ID=ubuntu\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"", healthyDocker(), true, true)
	r := d.Detect(context.Background(), "/opt/ultratorrent",
		[]PortStatus{{Port: 8080, Label: "UltraTorrent web UI"}})

	if r.Blocked() {
		t.Fatalf("a healthy host should not be blocked: %v", r.Failures())
	}
	if f, ok := findingFor(r, "Docker"); !ok || f.Level != LevelOK {
		t.Errorf("Docker finding = %+v", f)
	}
}

func TestMissingDockerIsAnActionOnSupportedAndAFailureElsewhere(t *testing.T) {
	// The distinction the whole OS check exists for: on Ubuntu the installer can
	// fix it, so it is an announced action rather than a refusal. On Fedora it
	// cannot, so it must stop rather than fail later in a confusing way.
	onUbuntu := detectorFor("ID=ubuntu", &fakeRunner{responses: map[string]string{"sudo -n true": ""}}, true, true).
		Detect(context.Background(), "/opt/ultratorrent", nil)
	if f, _ := findingFor(onUbuntu, "Docker"); f.Level != LevelAction {
		t.Errorf("on Ubuntu a missing Docker should be WILL INSTALL, got %v", f.Level)
	}
	if onUbuntu.Blocked() {
		t.Error("a supported host with no Docker must not be blocked")
	}

	onFedora := detectorFor("ID=fedora", &fakeRunner{responses: map[string]string{"sudo -n true": ""}}, true, true).
		Detect(context.Background(), "/opt/ultratorrent", nil)
	if !onFedora.Blocked() {
		t.Error("an unsupported host with no Docker must be blocked")
	}
}

func TestUnsupportedOSWithDockerIsOnlyAWarning(t *testing.T) {
	// The real requirement is Docker. A Fedora box already running it can deploy
	// this stack fine, and refusing would be the installer protecting itself
	// rather than the user.
	r := detectorFor("ID=fedora\nPRETTY_NAME=\"Fedora 40\"", healthyDocker(), true, true).
		Detect(context.Background(), "/opt/ultratorrent", nil)
	if r.Blocked() {
		t.Errorf("should not be blocked: %v", r.Failures())
	}
	if f, _ := findingFor(r, "Operating system"); f.Level != LevelWarn {
		t.Errorf("expected a warning, got %v", f.Level)
	}
}

func TestBusyPortBlocks(t *testing.T) {
	r := detectorFor("ID=ubuntu", healthyDocker(), false, true).
		Detect(context.Background(), "/opt/ultratorrent",
			[]PortStatus{{Port: 8080, Label: "UltraTorrent web UI"}})
	if !r.Blocked() {
		t.Fatal("a port already in use must block — the stack cannot publish there")
	}
	f, _ := findingFor(r, "Port 8080")
	if !strings.Contains(f.Remedy, "different port") {
		t.Errorf("the remedy should offer a way out: %+v", f)
	}
}

func TestUnreachableRegistryDistinguishesDNSFromConnectivity(t *testing.T) {
	// Two different fixes; "no internet" would describe both badly.
	d := detectorFor("ID=ubuntu", healthyDocker(), true, false)
	r := d.Detect(context.Background(), "/opt/ultratorrent", nil)
	f, ok := findingFor(r, "Docker registry")
	if !ok || f.Level != LevelFail {
		t.Fatalf("an unreachable registry must block: %+v", f)
	}
	if f.Detail == "" {
		t.Error("the failure should say which half failed")
	}
}

func TestLowResourcesWarnButNeverBlock(t *testing.T) {
	/*
	 * The repository documents no minimum RAM, CPU or disk, and the brief
	 * forbids inventing one. A small machine may well work; refusing it on a
	 * number nobody measured would be the installer overruling the operator.
	 */
	d := detectorFor("ID=ubuntu", healthyDocker(), true, true)
	d.ReadFile = func(name string) ([]byte, error) {
		switch name {
		case "/etc/os-release":
			return []byte("ID=ubuntu"), nil
		case "/proc/meminfo":
			return []byte("MemTotal:  1048576 kB"), nil // 1 GB
		}
		return nil, errors.New("no such file")
	}
	d.Statfs = func(string) (int64, int64, error) { return 2 << 30, 20 << 30, nil } // 2 GB free

	r := d.Detect(context.Background(), "/opt/ultratorrent", nil)
	if r.Blocked() {
		t.Fatalf("low resources must not block: %v", r.Failures())
	}
	if len(r.Warnings()) < 2 {
		t.Errorf("expected memory and disk warnings, got %v", r.Warnings())
	}
	// And the wording must not claim a measured minimum exists.
	for _, w := range r.Warnings() {
		if strings.Contains(w.Detail, "minimum") && !strings.Contains(w.Detail, "not a measured") {
			t.Errorf("a recommendation should not read as a measured minimum: %q", w.Detail)
		}
	}
}

func TestNoPrivilegesBlocks(t *testing.T) {
	// No root, no sudo, no docker group: nothing can be created or deployed.
	r := detectorFor("ID=ubuntu", &fakeRunner{}, true, true).
		Detect(context.Background(), "/opt/ultratorrent", nil)
	if !r.Blocked() {
		t.Error("a host where nothing can be installed must block")
	}
}

func TestExistingAncestorWalksUp(t *testing.T) {
	// The install directory does not exist yet; free space must be measured on
	// the filesystem it will be created on.
	if got := existingAncestor("/opt/ultratorrent/definitely/not/here"); got != "/opt" && got != "/" {
		t.Errorf("existingAncestor = %q, want an existing ancestor", got)
	}
	if got := existingAncestor("/"); got != "/" {
		t.Errorf("root should resolve to itself, got %q", got)
	}
	if got := existingAncestor(""); got != "/" {
		t.Errorf("empty should resolve to /, got %q", got)
	}
}

func TestPortIsFreeDetectsABoundPort(t *testing.T) {
	// Binds rather than connects: a connect-based check calls a held-but-not-
	// accepting socket "free" and a firewalled port "in use", both wrong.
	l, err := listenAny()
	if err != nil {
		t.Skip("cannot bind a port in this environment")
	}
	defer l.close()
	if PortIsFree(l.port) {
		t.Errorf("port %d is bound but reported free", l.port)
	}
}

func TestResetTagRequiresANewerCompose(t *testing.T) {
	/*
	 * A FAILURE rather than a warning, deliberately. On an older Compose the
	 * `!reset` tag is a YAML parse error, so the whole stack fails to start —
	 * worse than the port simply being published, and it would look like a fault
	 * in the installer's generated file rather than in the Compose version.
	 */
	old := &Report{Compose: ComposeInfo{Installed: true, Version: "2.20.0"}}
	old.RequireResetTag()
	if !old.Blocked() {
		t.Error("Compose 2.20 cannot parse !reset and must block")
	}

	current := &Report{Compose: ComposeInfo{Installed: true, Version: "2.24.0"}}
	current.RequireResetTag()
	if current.Blocked() {
		t.Error("Compose 2.24 supports !reset")
	}

	// A missing or v1 Compose is already reported by a more useful finding; this
	// check must not pile a second, more confusing one on top.
	absent := &Report{Compose: ComposeInfo{Installed: false}}
	absent.RequireResetTag()
	if len(absent.Findings) != 0 {
		t.Errorf("nothing to add when Compose is absent, got %v", absent.Findings)
	}
}
