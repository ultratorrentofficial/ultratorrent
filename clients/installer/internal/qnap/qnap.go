// Package qnap handles what QTS does differently.
//
// QNAP's QTS runs its ROOT FILESYSTEM FROM RAM. /usr/local/bin and /root are
// emptied by every reboot, so anything installed there — a binary, and the
// console's stored login with it — is gone after a restart, while the container
// stack under /share comes back untouched. QTS's answer is autorun.sh on the
// DOM, a script it runs as root at every boot.
package qnap

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Paths QTS defines. Variables rather than constants so tests can point them
// at a temporary directory instead of the real DOM.
var (
	DOMPath     = "/mnt/HDA_ROOT"
	AutorunPath = "/mnt/HDA_ROOT/autorun.sh"
	ConfigPath  = "/etc/config/uLinux.conf"
)

// Markers delimit the block this installer owns.
//
// Everything between them is ours to rewrite; everything outside is the
// operator's and is never touched. Without a marker the only ways to update
// would be to duplicate the block on every run or to rewrite a file that may
// hold somebody's own boot-time work.
const (
	startMarker = "# >>> UltraTorrent installer: utconsole >>>"
	endMarker   = "# <<< UltraTorrent installer: utconsole <<<"
)

// Detected reports whether this is a QTS host that will run autorun.sh.
//
// Both halves matter. The DOM says it is QTS; `Autorun = TRUE` says QTS will
// actually execute the script. Writing a boot script that the system is
// configured to ignore would be worse than not writing one, because it would be
// reported as done and would silently never run.
func Detected() (ok bool, why string) {
	if fi, err := os.Stat(DOMPath); err != nil || !fi.IsDir() {
		return false, "not a QTS host"
	}
	content, err := os.ReadFile(ConfigPath)
	if err != nil {
		return false, "QTS, but " + ConfigPath + " could not be read"
	}
	for _, line := range strings.Split(string(content), "\n") {
		field := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(line), " ", ""))
		if field == "autorun=true" {
			return true, "QTS with autorun enabled"
		}
		if field == "autorun=false" {
			return false, "QTS, but autorun is disabled in Control Panel"
		}
	}
	return false, "QTS, but autorun is not configured"
}

// Block is the text this installer maintains inside autorun.sh.
func Block(launcher string) string {
	return fmt.Sprintf(`%s
# QTS empties /usr/local/bin on every boot, so the console is re-linked here.
# The launcher itself lives on persistent storage with the installation.
if [ -x %q ]; then
  ln -sf %q /usr/local/bin/utconsole 2>/dev/null
fi
%s`, startMarker, launcher, launcher, endMarker)
}

// Result describes what EnsureAutorun did, for reporting.
type Result struct {
	Path    string
	Created bool // the file did not exist and was written
	Updated bool // our block was already there and changed
	Added   bool // our block was added to a file that already existed
	Skipped bool // already correct
}

// EnsureAutorun puts the block into autorun.sh without disturbing the rest.
//
// The insertion point is the part that matters. A shell script that ends in
// `exit 0` — and QNAP's own examples do — runs nothing appended after it, so
// naively appending produces a block that is present, looks right, and never
// executes. The block therefore goes BEFORE a trailing `exit 0` when there is
// one, and only at the end when there is not.
func EnsureAutorun(launcher string, dryRun bool) (Result, error) {
	res := Result{Path: AutorunPath}
	block := Block(launcher)

	existing, err := os.ReadFile(AutorunPath)
	switch {
	case os.IsNotExist(err):
		res.Created = true
		if dryRun {
			return res, nil
		}
		content := "#!/bin/sh\n" +
			"# Created by the UltraTorrent installer. QTS runs this at every boot.\n\n" +
			block + "\n\nexit 0\n"
		if err := os.WriteFile(AutorunPath, []byte(content), 0o755); err != nil {
			return res, fmt.Errorf("creating %s: %w", AutorunPath, err)
		}
		return res, nil

	case err != nil:
		return res, fmt.Errorf("reading %s: %w", AutorunPath, err)
	}

	current := string(existing)
	if updated, changed, found := replaceBlock(current, block); found {
		res.Updated = changed
		res.Skipped = !changed
		if changed && !dryRun {
			if err := writePreservingMode(AutorunPath, updated); err != nil {
				return res, err
			}
		}
		return res, nil
	}

	res.Added = true
	if dryRun {
		return res, nil
	}
	if err := writePreservingMode(AutorunPath, insertBlock(current, block)); err != nil {
		return res, err
	}
	// A boot script that is not executable is a boot script that does nothing.
	if err := os.Chmod(AutorunPath, 0o755); err != nil {
		return res, fmt.Errorf("making %s executable: %w", AutorunPath, err)
	}
	return res, nil
}

// replaceBlock rewrites an existing block in place, leaving everything else.
func replaceBlock(content, block string) (result string, changed, found bool) {
	start := strings.Index(content, startMarker)
	if start < 0 {
		return content, false, false
	}
	end := strings.Index(content[start:], endMarker)
	if end < 0 {
		// An opening marker with no close: someone edited inside our block.
		// Leaving it alone is safer than guessing where it was meant to end.
		return content, false, false
	}
	end += start + len(endMarker)
	if content[start:end] == block {
		return content, false, true
	}
	return content[:start] + block + content[end:], true, true
}

// insertBlock places the block where it will actually run.
func insertBlock(content, block string) string {
	lines := strings.Split(content, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if trimmed == "exit 0" || trimmed == "exit" {
			// Before the exit, or it would never run.
			out := append([]string{}, lines[:i]...)
			out = append(out, "", block, "")
			out = append(out, lines[i:]...)
			return strings.Join(out, "\n")
		}
		break
	}
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	return content + "\n" + block + "\n"
}

func writePreservingMode(path, content string) error {
	mode := os.FileMode(0o755)
	if fi, err := os.Stat(path); err == nil {
		mode = fi.Mode().Perm()
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}
	return nil
}

// RemovalHint tells the operator how to undo this.
func RemovalHint() string {
	return "to undo: delete the marked block from " + filepath.Clean(AutorunPath)
}
