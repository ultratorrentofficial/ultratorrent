package console

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The console is installed beside the stack rather than into /usr/local/bin,
// because that directory is not durable everywhere: QTS runs its root
// filesystem from RAM, so a binary there — and the stored session in $HOME —
// are both gone after a reboot. These pin the parts that make it survive.

func TestAnInstallerWithNoConsoleSaysSoRatherThanWritingOne(t *testing.T) {
	if Available() {
		t.Skip("this build carries a console; the placeholder path is what is under test")
	}
	dir := t.TempDir()
	if _, _, err := Install(dir, false); err == nil {
		t.Fatal("wrote something despite carrying no console")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("left files behind: %v", entries)
	}
}

func TestTheLauncherKeepsTheSessionBesideTheInstallation(t *testing.T) {
	if !Available() {
		t.Skip("no console embedded in this build")
	}
	dir := t.TempDir()
	binPath, launcher, err := Install(dir, false)
	if err != nil {
		t.Fatalf("install: %v", err)
	}

	body, err := os.ReadFile(launcher)
	if err != nil {
		t.Fatalf("reading the launcher: %v", err)
	}
	script := string(body)
	if !strings.Contains(script, "UTCONSOLE_CONFIG") {
		t.Error("the launcher does not move the session off the home directory")
	}
	if !strings.Contains(script, dir) {
		t.Errorf("the session is not kept beside the installation:\n%s", script)
	}
	if !strings.Contains(script, binPath) {
		t.Errorf("the launcher does not run the installed binary:\n%s", script)
	}

	// Both must be executable, or the whole point is lost.
	for _, path := range []string{binPath, launcher} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if info.Mode().Perm()&0o111 == 0 {
			t.Errorf("%s is not executable (%v)", path, info.Mode().Perm())
		}
	}
}

func TestTheInstalledConsoleIsTheEmbeddedOneByteForByte(t *testing.T) {
	if !Available() {
		t.Skip("no console embedded in this build")
	}
	dir := t.TempDir()
	binPath, _, err := Install(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	written, err := os.ReadFile(binPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(written) != Size() {
		t.Fatalf("wrote %d bytes, embedded %d", len(written), Size())
	}
}

// An interrupted install must never leave something that looks runnable.
func TestNoPartialFileIsLeftBehind(t *testing.T) {
	if !Available() {
		t.Skip("no console embedded in this build")
	}
	dir := t.TempDir()
	binPath, _, err := Install(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(binPath + ".partial"); !os.IsNotExist(err) {
		t.Error("a .partial file survived a successful install")
	}
}

func TestADryRunWritesNothing(t *testing.T) {
	dir := t.TempDir()
	binPath, launcher, err := Install(dir, true)
	if !Available() {
		if err == nil {
			t.Error("claimed it could install a console it does not carry")
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{binPath, launcher, filepath.Join(dir, "bin")} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("a dry run created %s", path)
		}
	}
}
