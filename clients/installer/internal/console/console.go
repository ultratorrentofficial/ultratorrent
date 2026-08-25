// Package console carries the UltraTorrent Console binary that ships with this
// installer, so an installation ends with a working console and no second
// download.
//
// Embedded rather than fetched: this installer is used on machines that have
// just been given Docker and may have no general internet access beyond a
// registry, and a first-run experience that depends on a download is one that
// fails in exactly the situation it is meant to rescue. Embedding also makes
// the architecture correct by construction — the console inside a linux/arm64
// installer is the linux/arm64 console.
package console

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
)

// binary is filled in at build time; see payload/README.md.
//
//go:embed payload/utconsole.bin
var binary []byte

// Name is what the console is called on disk.
const Name = "utconsole"

// Available reports whether this build actually carries a console.
//
// An installer built without running build.sh embeds the empty placeholder, and
// must say so rather than write a zero-byte file that fails to execute.
func Available() bool { return len(binary) > 0 }

// Size is how large the embedded console is, for reporting.
func Size() int { return len(binary) }

// Install writes the console and a launcher beside the installation.
//
// Beside the installation, and NOT into /usr/local/bin, because that directory
// is not durable everywhere: QTS runs its root filesystem from RAM, so a binary
// placed there — and the session in $HOME with it — is gone after a reboot. The
// installation directory is persistent by definition; it is where .env lives.
//
// The launcher exists for the same reason. It points UTCONSOLE_CONFIG at the
// installation, so the stored login survives a restart on a host whose home
// directory does not.
func Install(dir string, dryRun bool) (binPath, launcherPath string, err error) {
	binPath = filepath.Join(dir, "bin", Name)
	launcherPath = filepath.Join(dir, Name)
	if !Available() {
		return "", "", fmt.Errorf("this installer was built without a console")
	}
	if dryRun {
		return binPath, launcherPath, nil
	}

	if err := os.MkdirAll(filepath.Dir(binPath), 0o755); err != nil {
		return "", "", fmt.Errorf("creating %s: %w", filepath.Dir(binPath), err)
	}
	// Written to a temporary name and renamed, so an interrupted install cannot
	// leave a half-written executable that someone then runs.
	tmp := binPath + ".partial"
	if err := os.WriteFile(tmp, binary, 0o755); err != nil {
		return "", "", fmt.Errorf("writing %s: %w", binPath, err)
	}
	if err := os.Rename(tmp, binPath); err != nil {
		os.Remove(tmp)
		return "", "", fmt.Errorf("installing %s: %w", binPath, err)
	}
	if err := os.Chmod(binPath, 0o755); err != nil {
		return "", "", fmt.Errorf("making %s executable: %w", binPath, err)
	}

	launcher := fmt.Sprintf(`#!/bin/sh
# UltraTorrent Console, with its session stored beside this installation.
#
# Written by the installer. The default configuration location is under the
# user's home directory, which on some systems — QNAP's QTS among them — lives
# on a RAM filesystem and is emptied by a reboot, taking the stored login with
# it. This keeps it on the same storage as the installation itself.
UTCONSOLE_CONFIG="%s/.%s/config.json"
export UTCONSOLE_CONFIG
exec "%s" "$@"
`, dir, Name, binPath)
	if err := os.WriteFile(launcherPath, []byte(launcher), 0o755); err != nil {
		return "", "", fmt.Errorf("writing %s: %w", launcherPath, err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "."+Name), 0o700); err != nil {
		return "", "", fmt.Errorf("creating the console's configuration directory: %w", err)
	}
	return binPath, launcherPath, nil
}
