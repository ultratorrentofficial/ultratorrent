package plan

import (
	"strings"
	"testing"
)

// Every test here runs on the Linux build. That is the requirement, not a
// convenience: Windows path handling is where installers go quietly wrong, and
// rules that can only be exercised on Windows are rules CI never checks.

func TestHostPathRulesFollowTheTargetNotTheBuild(t *testing.T) {
	// The bug this prevents: `filepath.IsAbs` answers for the machine the binary
	// was COMPILED for. On a Windows build `/opt/ultratorrent` is not absolute,
	// so a plan authored on Linux was rejected by the Windows binary — and a
	// plan is meant to be saved, diffed and re-used.
	if !TargetLinux.IsAbsHostPath("/opt/ultratorrent") {
		t.Error("/opt/ultratorrent must be absolute for a Linux target")
	}
	if TargetWindows.IsAbsHostPath("/opt/ultratorrent") {
		t.Error("/opt/ultratorrent must not be absolute for a Windows target")
	}
	if !TargetWindows.IsAbsHostPath(`C:\ProgramData\UltraTorrent`) {
		t.Error(`C:\ProgramData\UltraTorrent must be absolute for a Windows target`)
	}
	if TargetLinux.IsAbsHostPath(`C:\ProgramData\UltraTorrent`) {
		t.Error("a drive-letter path must not be absolute for a Linux target")
	}
	// Windows accepts forward slashes, people paste them, and Docker prints
	// them. Refusing them would reject a path that works.
	if !TargetWindows.IsAbsHostPath("D:/Media") {
		t.Error("D:/Media is a usable Windows path")
	}
}

func TestWindowsPathHazards(t *testing.T) {
	cases := []struct {
		path string
		want string // substring of the expected problem
		why  string
	}{
		{`C:Media`, "relative to the current directory",
			"drive-relative: looks absolute, resolves against the current directory on C:"},
		{`\Media`, "must name a drive",
			"rooted with no volume: resolves against whichever drive is current"},
		{`Media\Movies`, "must be an absolute path", "plainly relative"},
		{`D:\Media\..\Windows`, "'..'", "traversal"},
		{`D:\Media\CON`, "reserved Windows device name",
			"CON is a device in every directory; the mkdir fails as a permission error"},
		{`D:\Media\NUL.txt`, "reserved Windows device name",
			"reserved names are reserved with an extension too"},
		{`D:\Media\lpt1\x`, "reserved Windows device name", "and case does not save it"},
		{`D:\Media\Films<2024>`, "must not contain", "characters NTFS forbids"},
		{`D:\Media\Movies:stream`, "outside the drive letter", "alternate data stream"},
		{`D:\Media\Movies `, "space or a dot",
			"Windows strips it silently, so the directory created is not the one asked for"},
		{`D:\Media\Movies.`, "space or a dot", "same for a trailing dot"},
	}
	for _, c := range cases {
		t.Run(c.path, func(t *testing.T) {
			got := TargetWindows.HostPathProblem(c.path)
			if got == "" {
				t.Fatalf("%s — accepted, but %s", c.path, c.why)
			}
			if !strings.Contains(got, c.want) {
				t.Errorf("problem = %q, want it to mention %q", got, c.want)
			}
		})
	}

	for _, ok := range []string{
		`D:\Media`,
		`C:\ProgramData\UltraTorrent`,
		`D:\Media\TV Shows`, // spaces are ordinary, and everywhere
		`D:\`,
		`\\NAS01\Media\TV`,
		`D:/Media/TV Shows`,
	} {
		if problem := TargetWindows.HostPathProblem(ok); problem != "" {
			t.Errorf("%s should be accepted, got %q", ok, problem)
		}
	}
}

func TestUnixPathRules(t *testing.T) {
	if problem := TargetLinux.HostPathProblem("srv/media"); !strings.Contains(problem, "absolute") {
		t.Errorf("a relative path must be refused, got %q", problem)
	}
	if problem := TargetLinux.HostPathProblem("/srv/../etc"); !strings.Contains(problem, "'..'") {
		t.Errorf("traversal must be refused, got %q", problem)
	}
	if problem := TargetLinux.HostPathProblem("/srv/media"); problem != "" {
		t.Errorf("a plain absolute path must be accepted, got %q", problem)
	}
	// A colon is a legal character in a Unix filename and must not inherit the
	// Windows rule.
	if problem := TargetLinux.HostPathProblem("/srv/media:1"); problem != "" {
		t.Errorf("a colon is legal on Unix, got %q", problem)
	}
}

// TestWindowsContainmentIsCaseInsensitive is the guard the check exists for.
//
// "Keep media out of the installation directory" is enforced by containment. On
// NTFS, `d:\media` and `D:\Media` are the same directory — so a case-sensitive
// comparison lets an operator defeat the check by typing a different case, and
// the failure only appears later when a cleanup reaches both.
func TestWindowsContainmentIsCaseInsensitive(t *testing.T) {
	install := `C:\ProgramData\UltraTorrent`
	if !TargetWindows.WithinHostPath(install, `c:\programdata\ultratorrent\media`) {
		t.Error("case must not defeat containment on Windows")
	}
	if !TargetWindows.WithinHostPath(install, `C:\ProgramData\UltraTorrent\media`) {
		t.Error("the plain case must be contained too")
	}
	// A sibling whose name merely starts the same is NOT inside.
	if TargetWindows.WithinHostPath(`D:\Media`, `D:\Media2`) {
		t.Error(`D:\Media2 is a sibling of D:\Media, not a child`)
	}
	// A different volume is never inside.
	if TargetWindows.WithinHostPath(`C:\Data`, `D:\Data\media`) {
		t.Error("a different drive cannot be contained")
	}
	if TargetWindows.WithinHostPath(install, `D:\Media`) {
		t.Error("an unrelated drive is not contained")
	}
}

func TestUnixContainmentStaysCaseSensitive(t *testing.T) {
	// Two different directories on Linux, and the check must not merge them.
	if TargetLinux.WithinHostPath("/opt/ultratorrent", "/opt/UltraTorrent/media") {
		t.Error("Linux paths are case-sensitive")
	}
	if !TargetLinux.WithinHostPath("/opt/ultratorrent", "/opt/ultratorrent/media") {
		t.Error("the real child must be contained")
	}
	// The sibling case the old string-prefix comparison was written to handle.
	if TargetLinux.WithinHostPath("/opt/ultratorrent", "/opt/ultratorrent-data") {
		t.Error("a name-prefix sibling is not a child")
	}
}

func TestUNCIsAllowedButAdvisedAgainst(t *testing.T) {
	unc := `\\NAS01\Media`
	if problem := TargetWindows.HostPathProblem(unc); problem != "" {
		t.Errorf("a UNC path is valid, got %q", problem)
	}
	advisory := TargetWindows.HostPathAdvisory(unc)
	if advisory == "" {
		t.Fatal("a UNC path must carry a caution: Docker runs in its own session")
	}
	if !strings.Contains(advisory, "Docker") {
		t.Errorf("the caution should say what the risk is, got %q", advisory)
	}
	// A server with no share names no directory.
	if problem := TargetWindows.HostPathProblem(`\\NAS01`); problem == "" {
		t.Error(`\\NAS01 names a server, not a directory`)
	}
	// Drive paths get no such caution.
	if TargetWindows.HostPathAdvisory(`D:\Media`) != "" {
		t.Error("a local drive needs no UNC caution")
	}
}

// TestAWindowsPlanValidatesOnALinuxBuild is the end-to-end of the change.
func TestAWindowsPlanValidatesOnALinuxBuild(t *testing.T) {
	p := RecommendedFor("test", TargetWindows)
	p.Storage = Storage{Mode: StorageBind, MediaRoot: `D:\Media`}
	p.Finalize()

	if problems := Errors(p.Validate()); len(problems) > 0 {
		t.Fatalf("a Windows plan should validate on a Linux build: %v", problems)
	}
	if p.InstallDirectory != DefaultInstallDirectoryWindows {
		t.Errorf("install directory = %q, want the Windows default", p.InstallDirectory)
	}

	// The same paths against a Linux target are wrong, and must be reported as
	// wrong rather than silently accepted by whichever build is running.
	p.TargetOS = TargetLinux
	problems := Errors(p.Validate())
	if len(problems) == 0 {
		t.Fatal("Windows paths must not validate for a Linux target")
	}
}

func TestAPlanWithoutATargetIsRefused(t *testing.T) {
	p := Recommended("test")
	p.TargetOS = ""
	p.Finalize()
	found := false
	for _, problem := range Errors(p.Validate()) {
		if problem.Field == "targetOs" {
			found = true
		}
	}
	if !found {
		// Defaulting silently would validate Windows paths against Linux rules,
		// which is the whole bug this field exists to close.
		t.Error("a plan with no target must say so rather than assume one")
	}
}
