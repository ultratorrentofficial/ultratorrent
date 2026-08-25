package qnap

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// autorun.sh runs as root at boot and may already hold work that is not ours.
// The two ways to get this wrong are to break what is there, and to add a block
// that looks right and never runs.

func withAutorun(t *testing.T, initial string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "autorun.sh")
	if initial != "" {
		if err := os.WriteFile(path, []byte(initial), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	old := AutorunPath
	AutorunPath = path
	t.Cleanup(func() { AutorunPath = old })
	return path
}

const launcher = "/share/Container/ultratorrent-core/utconsole"

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading result: %v", err)
	}
	return string(b)
}

func TestAMissingAutorunIsCreatedComplete(t *testing.T) {
	path := withAutorun(t, "")
	res, err := EnsureAutorun(launcher, false)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Created {
		t.Error("did not report creating the file")
	}
	body := read(t, path)
	for _, want := range []string{"#!/bin/sh", startMarker, launcher, endMarker, "exit 0"} {
		if !strings.Contains(body, want) {
			t.Errorf("created file is missing %q:\n%s", want, body)
		}
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm()&0o111 == 0 {
		t.Error("created a boot script that is not executable")
	}
}

// The failure that would look like success: a script ending in `exit 0` runs
// nothing appended after it.
func TestTheBlockGoesBeforeATrailingExit(t *testing.T) {
	path := withAutorun(t, "#!/bin/sh\n/share/scripts/mount-nas.sh\nexit 0\n")
	if _, err := EnsureAutorun(launcher, false); err != nil {
		t.Fatal(err)
	}
	body := read(t, path)
	blockAt := strings.Index(body, startMarker)
	exitAt := strings.LastIndex(body, "exit 0")
	if blockAt < 0 {
		t.Fatalf("block was never added:\n%s", body)
	}
	if blockAt > exitAt {
		t.Errorf("block was placed AFTER `exit 0`, so it would never run:\n%s", body)
	}
	if !strings.Contains(body, "/share/scripts/mount-nas.sh") {
		t.Errorf("the operator's own line was lost:\n%s", body)
	}
}

func TestAnExistingScriptWithoutAnExitIsAppendedTo(t *testing.T) {
	path := withAutorun(t, "#!/bin/sh\n/share/scripts/mount-nas.sh\n")
	if _, err := EnsureAutorun(launcher, false); err != nil {
		t.Fatal(err)
	}
	body := read(t, path)
	if !strings.Contains(body, "/share/scripts/mount-nas.sh") {
		t.Errorf("lost the operator's line:\n%s", body)
	}
	if !strings.Contains(body, startMarker) {
		t.Errorf("block was not added:\n%s", body)
	}
}

// Re-running an installer is ordinary. It must not stack up blocks.
func TestRunningTwiceChangesNothingTheSecondTime(t *testing.T) {
	path := withAutorun(t, "#!/bin/sh\nexit 0\n")
	if _, err := EnsureAutorun(launcher, false); err != nil {
		t.Fatal(err)
	}
	first := read(t, path)

	res, err := EnsureAutorun(launcher, false)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Skipped {
		t.Errorf("second run did not report the block as already correct: %+v", res)
	}
	if second := read(t, path); second != first {
		t.Errorf("second run rewrote the file:\n--- first ---\n%s\n--- second ---\n%s", first, second)
	}
	if n := strings.Count(read(t, path), startMarker); n != 1 {
		t.Errorf("%d copies of the block", n)
	}
}

// Moving the installation must update the block rather than add another.
func TestAMovedInstallationUpdatesTheBlockInPlace(t *testing.T) {
	path := withAutorun(t, "#!/bin/sh\n/share/scripts/mount-nas.sh\nexit 0\n")
	if _, err := EnsureAutorun("/old/path/utconsole", false); err != nil {
		t.Fatal(err)
	}
	res, err := EnsureAutorun(launcher, false)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Updated {
		t.Errorf("did not report updating: %+v", res)
	}
	body := read(t, path)
	if strings.Contains(body, "/old/path/utconsole") {
		t.Errorf("the old path survived:\n%s", body)
	}
	if n := strings.Count(body, startMarker); n != 1 {
		t.Errorf("%d copies of the block", n)
	}
	if !strings.Contains(body, "/share/scripts/mount-nas.sh") {
		t.Errorf("the operator's line was lost:\n%s", body)
	}
}

// Someone editing inside our block is a reason to stop, not to guess.
func TestAnUnterminatedBlockIsLeftAlone(t *testing.T) {
	broken := "#!/bin/sh\n" + startMarker + "\nsomething someone was editing\nexit 0\n"
	path := withAutorun(t, broken)
	if _, err := EnsureAutorun(launcher, false); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(read(t, path), "something someone was editing") {
		t.Error("destroyed a half-edited block")
	}
}

func TestADryRunWritesNothing(t *testing.T) {
	path := withAutorun(t, "#!/bin/sh\nexit 0\n")
	before := read(t, path)
	res, err := EnsureAutorun(launcher, true)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Added {
		t.Errorf("a dry run should still say what it would do: %+v", res)
	}
	if read(t, path) != before {
		t.Error("a dry run modified the file")
	}
}

// Detection needs BOTH facts: a boot script the system is set to ignore is
// worse than none, because it reports as done and never runs.
func TestDetectionRequiresAutorunToBeEnabled(t *testing.T) {
	dir := t.TempDir()
	oldDOM, oldCfg := DOMPath, ConfigPath
	DOMPath, ConfigPath = filepath.Join(dir, "HDA_ROOT"), filepath.Join(dir, "uLinux.conf")
	t.Cleanup(func() { DOMPath, ConfigPath = oldDOM, oldCfg })

	if ok, _ := Detected(); ok {
		t.Error("claimed QTS with no DOM present")
	}
	os.MkdirAll(DOMPath, 0o755)

	os.WriteFile(ConfigPath, []byte("[Misc]\nAutorun = FALSE\n"), 0o644)
	if ok, why := Detected(); ok {
		t.Errorf("would have written a script QTS ignores (%s)", why)
	}
	os.WriteFile(ConfigPath, []byte("[Misc]\nAutorun = TRUE\n"), 0o644)
	if ok, why := Detected(); !ok {
		t.Errorf("did not detect an autorun-enabled QTS host (%s)", why)
	}
}
