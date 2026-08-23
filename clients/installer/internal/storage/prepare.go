package storage

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/ultratorrent/installer/internal/host"
)

// Ops are the filesystem operations, injected so every interesting case here —
// a path that is a file, an unwritable parent, a media root on the root disk —
// is a table test rather than a machine someone has to build.
type Ops struct {
	Stat     func(string) (os.FileInfo, error)
	MkdirAll func(string, fs.FileMode) error
	// Chmod re-asserts the mode after creation. MkdirAll's is masked by the
	// process umask, so the mode requested is not the mode created.
	Chmod func(string, fs.FileMode) error
	Chown func(string, int, int) error
	// WriteProbe reports whether a directory can actually be written to.
	// A real write, not a permission-bit calculation: the bits say nothing about
	// a read-only mount, a full filesystem, or something a security module
	// forbids, and all three fail later in ways that look unrelated.
	WriteProbe func(string) error
	// DeviceID identifies the filesystem a path is on, for the not-mounted check.
	DeviceID func(string) (uint64, bool)
}

// DefaultOps operate on the real filesystem.
func DefaultOps() Ops {
	return Ops{
		Stat:       os.Stat,
		MkdirAll:   os.MkdirAll,
		Chmod:      os.Chmod,
		Chown:      os.Chown,
		WriteProbe: writeProbe,
		DeviceID:   deviceID,
	}
}

func writeProbe(dir string) error {
	f, err := os.CreateTemp(dir, ".ultratorrent-write-probe-*")
	if err != nil {
		return err
	}
	name := f.Name()
	f.Close()
	return os.Remove(name)
}

// Inspect reports what is wrong before anything is created.
//
// Every finding here is something that otherwise surfaces later as an error
// naming an internal Docker path, a permission failure mid-import, or — worst —
// nothing at all, while terabytes land on the wrong disk.
func Inspect(dirs []Directory, installDir string, ops Ops) []host.Finding {
	if len(dirs) == 0 {
		return nil
	}
	var findings []host.Finding

	for _, dir := range dirs {
		info, err := ops.Stat(dir.Path)
		switch {
		case err == nil && !info.IsDir():
			findings = append(findings, host.Finding{
				Label:  dir.Purpose,
				Value:  dir.Path,
				Level:  host.LevelFail,
				Detail: "exists but is not a directory",
				Remedy: "choose another path, or move the file out of the way",
			})
			continue

		case err == nil:
			findings = append(findings, inspectExisting(dir, ops))

		case os.IsNotExist(err):
			findings = append(findings, inspectMissing(dir, ops))

		case errors.Is(err, syscall.ENOTDIR):
			// A parent component is a file. The raw "not a directory" names the
			// full path and reads as though the leaf were the problem, which
			// sends the operator looking in the wrong place.
			findings = append(findings, host.Finding{
				Label:  dir.Purpose,
				Value:  dir.Path,
				Level:  host.LevelFail,
				Detail: "cannot exist: a parent of this path is a file, not a directory",
				Remedy: "fix the parent path first",
			})

		default:
			findings = append(findings, host.Finding{
				Label:  dir.Purpose,
				Value:  dir.Path,
				Level:  host.LevelFail,
				Detail: err.Error(),
			})
		}
	}

	if f, ok := inspectSameFilesystem(dirs[0], installDir, ops); ok {
		findings = append(findings, f)
	}
	return findings
}

// inspectExisting checks a directory that is already there.
func inspectExisting(dir Directory, ops Ops) host.Finding {
	f := host.Finding{Label: dir.Purpose, Value: dir.Path, Level: host.LevelOK}

	if err := ops.WriteProbe(dir.Path); err != nil {
		f.Level = host.LevelFail
		f.Detail = "exists but cannot be written to: " + err.Error()
		f.Remedy = "check ownership, the mount's read-only flag, and free space"
		return f
	}

	/*
	 * Ownership is REPORTED, never corrected.
	 *
	 * A recursive chown of an existing media tree is slow, hard to undo, and on a
	 * NAS routinely wrong — the tree is often shared with other applications that
	 * expect their own ownership. The installer owns what it creates and says
	 * what it found about the rest.
	 */
	if dir.Owner != nil {
		if uid, gid, ok := ownerOf(ops, dir.Path); ok && (uid != dir.Owner.UID || gid != dir.Owner.GID) {
			f.Level = host.LevelWarn
			f.Detail = fmt.Sprintf("owned by %d:%d, but downloads will be written as %s",
				uid, gid, dir.Owner)
			f.Remedy = fmt.Sprintf(
				"if the engine cannot write here, run: chown -R %s %s "+
					"(left to you: this tree may be shared with other applications)",
				dir.Owner, dir.Path)
		}
	}
	return f
}

// inspectMissing checks a directory that has to be created.
func inspectMissing(dir Directory, ops Ops) host.Finding {
	f := host.Finding{Label: dir.Purpose, Value: dir.Path}

	// The nearest ancestor that exists is what decides whether creation can work.
	parent := nearestExisting(ops, dir.Path)
	if parent == "" {
		f.Level = host.LevelFail
		f.Detail = "does not exist, and neither does any parent"
		f.Remedy = "check the path for a typo, and that the disk is mounted"
		return f
	}
	if err := ops.WriteProbe(parent); err != nil {
		f.Level = host.LevelFail
		f.Detail = fmt.Sprintf("does not exist and %s cannot be written to: %v", parent, err)
		f.Remedy = "create it yourself, or choose a path the installer can write"
		return f
	}

	f.Level = host.LevelAction
	f.Detail = "does not exist yet"
	if dir.Required {
		// Worth stating plainly: this one is not a convenience.
		f.Detail = "does not exist yet; the stack cannot start without it"
	}
	f.Remedy = "will be created"
	return f
}

// inspectSameFilesystem catches the mistake that costs the most to discover late.
//
// A media root on the same filesystem as the installation almost always means
// the array, the NAS share or the external disk is NOT MOUNTED, and the path is
// an empty directory sitting on the root disk. Nothing fails; the stack comes up
// and works. It is discovered when the root filesystem fills, days later, with
// media that then has to be moved off it by hand — and moving it is not a
// rename, because the destination is a different device.
func inspectSameFilesystem(mediaRoot Directory, installDir string, ops Ops) (host.Finding, bool) {
	if installDir == "" || ops.DeviceID == nil {
		return host.Finding{}, false
	}
	// Compare the nearest existing ancestor, since the media root may not exist.
	mediaAnchor := nearestExisting(ops, mediaRoot.Path)
	installAnchor := nearestExisting(ops, installDir)
	if mediaAnchor == "" || installAnchor == "" {
		return host.Finding{}, false
	}
	mediaDev, ok1 := ops.DeviceID(mediaAnchor)
	installDev, ok2 := ops.DeviceID(installAnchor)
	if !ok1 || !ok2 || mediaDev != installDev {
		return host.Finding{}, false
	}
	return host.Finding{
		Label: "media storage device",
		Value: mediaRoot.Path,
		Level: host.LevelWarn,
		Detail: fmt.Sprintf(
			"on the same filesystem as %s — if you meant a separate disk or NAS share, "+
				"it is not mounted", installDir),
		Remedy: "mount it first, then re-run; media written before it is mounted " +
			"stays on the root disk and is hidden once the mount happens",
	}, true
}

// Action is one thing Prepare did, or would do.
type Action struct {
	Path   string
	Kind   string // create | chown | unchanged
	Detail string
}

func (a Action) String() string {
	if a.Detail == "" {
		return fmt.Sprintf("%-9s %s", a.Kind, a.Path)
	}
	return fmt.Sprintf("%-9s %s (%s)", a.Kind, a.Path, a.Detail)
}

// Prepare creates the directories, in the order Plan returned them.
//
// Only ever creates and chowns what it creates. Nothing here removes, empties or
// takes ownership of anything that already exists — a media tree is the one
// thing on the host that cannot be regenerated.
func Prepare(dirs []Directory, ops Ops, dryRun bool) ([]Action, error) {
	var actions []Action
	for _, dir := range dirs {
		if info, err := ops.Stat(dir.Path); err == nil {
			if !info.IsDir() {
				return actions, fmt.Errorf("%s exists and is not a directory", dir.Path)
			}
			actions = append(actions, Action{Path: dir.Path, Kind: "unchanged",
				Detail: "already exists; left as it is"})
			continue
		} else if !os.IsNotExist(err) {
			return actions, fmt.Errorf("checking %s: %w", dir.Path, err)
		}

		if dryRun {
			actions = append(actions, Action{Path: dir.Path, Kind: "create", Detail: dir.Purpose})
			continue
		}
		if err := ops.MkdirAll(dir.Path, DirMode); err != nil {
			return actions, fmt.Errorf("creating %s: %w", dir.Path, err)
		}
		// MkdirAll's mode is masked by the process umask, which is 022 on almost
		// every host — so the group-writable bit DirMode exists for is silently
		// dropped and the directory lands 0755. That breaks the arrangement
		// PUID/PGID is for: an engine and a backend running as different users in
		// a shared group can then no longer both write. Assert the mode instead.
		if err := ops.Chmod(dir.Path, DirMode); err != nil {
			return actions, fmt.Errorf("setting the mode on %s: %w", dir.Path, err)
		}
		actions = append(actions, Action{Path: dir.Path, Kind: "create", Detail: dir.Purpose})

		if dir.Owner != nil {
			if err := ops.Chown(dir.Path, dir.Owner.UID, dir.Owner.GID); err != nil {
				// Not fatal on its own: an unprivileged run cannot chown, and the
				// engine may still be able to write. Say so rather than stopping.
				actions = append(actions, Action{Path: dir.Path, Kind: "chown",
					Detail: "could not set ownership to " + dir.Owner.String() + ": " + err.Error()})
				continue
			}
			actions = append(actions, Action{Path: dir.Path, Kind: "chown", Detail: dir.Owner.String()})
		}
	}
	return actions, nil
}

// Blocked reports whether any finding stops the installation.
func Blocked(findings []host.Finding) bool {
	for _, f := range findings {
		if f.Level == host.LevelFail {
			return true
		}
	}
	return false
}

// nearestExisting walks up until it finds something that exists.
func nearestExisting(ops Ops, path string) string {
	for current := filepath.Clean(path); ; {
		if info, err := ops.Stat(current); err == nil && info.IsDir() {
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			return ""
		}
		current = parent
	}
}

// ownerOf reads a directory's uid/gid where the platform exposes them.
func ownerOf(ops Ops, path string) (uid, gid int, ok bool) {
	info, err := ops.Stat(path)
	if err != nil {
		return 0, 0, false
	}
	return statOwner(info)
}

// Summary renders the directory list for the review screen.
func Summary(dirs []Directory) string {
	if len(dirs) == 0 {
		return "  Docker named volume — nothing to prepare on the host\n"
	}
	var b strings.Builder
	for _, dir := range dirs {
		if dir.ContainerPath != "" {
			fmt.Fprintf(&b, "  %-40s -> %s  (%s)\n", dir.Path, dir.ContainerPath, dir.Purpose)
		} else {
			fmt.Fprintf(&b, "  %-40s     %s\n", dir.Path, dir.Purpose)
		}
	}
	return b.String()
}
