package plan

import (
	"runtime"
	"strings"
)

// The target operating system, and host-path rules that follow from it.
//
// This exists because `path/filepath` answers for the machine the BINARY was
// compiled for, and a plan is a document about the machine it will be APPLIED
// to. Those are usually the same and need not be: a plan is meant to be
// readable, diffable, saved and re-used, and `install --config plan.yaml` is an
// architected future.
//
// Left to filepath, the same plan.json validates on one build and is rejected
// by the other — Go's Windows `IsAbs` requires a volume name, so
// `/opt/ultratorrent` is not an absolute path there, and `C:\ProgramData` is
// not one on Linux. Every rule below therefore takes the target as data.
//
// The second reason is testability. Windows path handling is where an installer
// gets quietly, dangerously wrong — reserved device names, drive-relative
// paths, trailing dots, case-insensitive containment — and none of it can be
// exercised on the Linux build that CI runs unless the rules are written this
// way.

// TargetOS is the operating system a plan will be applied to.
type TargetOS string

const (
	TargetLinux   TargetOS = "linux"
	TargetWindows TargetOS = "windows"
)

// DefaultTargetOS is the platform this binary is running on.
//
// A default rather than an assumption: the wizard always writes the field, so a
// plan never carries an implicit target, and a plan read back from disk keeps
// whichever target it was authored for.
func DefaultTargetOS() TargetOS {
	if runtime.GOOS == "windows" {
		return TargetWindows
	}
	return TargetLinux
}

// Valid reports whether this is a target the installer understands.
func (t TargetOS) Valid() bool { return t == TargetLinux || t == TargetWindows }

// Separator is the target's path separator, for rendering.
func (t TargetOS) Separator() string {
	if t == TargetWindows {
		return `\`
	}
	return "/"
}

// windowsReservedNames are device names that cannot be a path component.
//
// They are reserved in EVERY directory, with or without an extension: a
// directory called `NUL` cannot be created, and `D:\Media\CON\file` resolves to
// a device rather than a file. Creating media libraries from user input without
// this check produces failures that look like permission errors.
var windowsReservedNames = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true,
	"COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true,
	"LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
}

// windowsForbidden are characters Windows does not permit in a path component.
// The colon is absent because it is legal as the drive separator and handled
// there; anywhere else it opens an alternate data stream, which splitWindows
// rejects by treating it as an invalid component character.
const windowsForbidden = `<>"|?*`

// HostPathProblem returns a reason this path cannot be used, or "".
//
// Reported as one sentence rather than a list: the operator is fixing one path
// at a time, and the first real problem is the one they act on.
func (t TargetOS) HostPathProblem(p string) string {
	if p == "" {
		return "a path is required"
	}
	if strings.ContainsRune(p, 0) {
		return "must not contain a null byte"
	}
	if t == TargetWindows {
		return windowsPathProblem(p)
	}
	return unixPathProblem(p)
}

func unixPathProblem(p string) string {
	if !strings.HasPrefix(p, "/") {
		return "must be an absolute path, starting with /"
	}
	for _, part := range strings.Split(p, "/") {
		if part == ".." {
			return "must not contain '..'"
		}
	}
	return ""
}

func windowsPathProblem(p string) string {
	volume, parts, kind := splitWindows(p)
	switch kind {
	case windowsPathRelative:
		return `must be an absolute path, such as D:\Media`
	case windowsPathRooted:
		// `\Media` is rooted on the CURRENT drive, which depends on where the
		// installer happened to be run from. Docker later receives a path with
		// no volume and fails in a way that names neither.
		return `must name a drive, such as D:\Media — a path that starts with a ` +
			`separator but no drive resolves against whichever drive is current`
	case windowsPathDriveRelative:
		// `C:Media` means "Media, relative to the current directory ON C:".
		// It looks absolute and is not; this is the classic Windows path bug.
		return `is relative to the current directory on ` + volume +
			` — write it in full, such as ` + volume + `\Media`
	}

	for _, part := range parts {
		switch {
		case part == "..":
			return "must not contain '..'"
		case strings.ContainsAny(part, windowsForbidden):
			return "must not contain any of " + windowsForbidden + ` — found in "` + part + `"`
		case strings.Contains(part, ":"):
			// A colon past the drive names an alternate data stream.
			return `must not contain ':' outside the drive letter — found in "` + part + `"`
		case windowsReservedNames[strings.ToUpper(stem(part))]:
			return `"` + part + `" is a reserved Windows device name and cannot be a folder`
		case strings.HasSuffix(part, " "), strings.HasSuffix(part, "."):
			// Windows silently strips these when creating the directory, so the
			// path that ends up on disk is not the one that was asked for — and
			// the bind mount then points somewhere the operator never named.
			return `"` + part + `" ends in a space or a dot, which Windows silently removes`
		}
		for _, r := range part {
			if r < 0x20 {
				return `must not contain control characters — found in "` + part + `"`
			}
		}
	}
	return ""
}

// stem is the component without its extension, for reserved-name checks:
// `NUL.txt` is as reserved as `NUL`.
func stem(part string) string {
	if i := strings.IndexByte(part, '.'); i >= 0 {
		return part[:i]
	}
	return part
}

// HostPathAdvisory returns a non-blocking caution about a path, or "".
func (t TargetOS) HostPathAdvisory(p string) string {
	if t != TargetWindows {
		return ""
	}
	if _, _, kind := splitWindows(p); kind == windowsPathUNC {
		return "a UNC path is only usable if the Docker environment can reach it " +
			"with the right credentials — Docker runs in its own session and does " +
			"not inherit a mapped drive or a logged-in user's share access"
	}
	return ""
}

// IsAbsHostPath reports whether p is absolute for this target.
func (t TargetOS) IsAbsHostPath(p string) bool {
	if p == "" {
		return false
	}
	if t == TargetWindows {
		_, _, kind := splitWindows(p)
		return kind == windowsPathDrive || kind == windowsPathUNC
	}
	return strings.HasPrefix(p, "/")
}

// WithinHostPath reports whether child sits inside parent.
//
// Compared COMPONENT BY COMPONENT rather than as a string prefix, so
// `D:\Media2` is not inside `D:\Media`, and case-insensitively on Windows,
// where `d:\media` and `D:\Media` are the same directory. The case rule is the
// point: a string comparison would let media be placed inside the installation
// directory — the thing this check exists to prevent — by typing it in a
// different case.
func (t TargetOS) WithinHostPath(parent, child string) bool {
	if parent == "" || child == "" {
		return false
	}
	pv, pp, pk := t.split(parent)
	cv, cp, ck := t.split(child)
	if pk != ck {
		return false
	}
	if !t.sameName(pv, cv) {
		return false
	}
	if len(cp) < len(pp) {
		return false
	}
	for i := range pp {
		if !t.sameName(pp[i], cp[i]) {
			return false
		}
	}
	return true
}

func (t TargetOS) sameName(a, b string) bool {
	if t == TargetWindows {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// split decomposes a path for either target into volume, components and shape.
func (t TargetOS) split(p string) (volume string, parts []string, kind windowsPathKind) {
	if t == TargetWindows {
		return splitWindows(p)
	}
	if !strings.HasPrefix(p, "/") {
		return "", cleanParts(strings.Split(p, "/")), windowsPathRelative
	}
	return "", cleanParts(strings.Split(p, "/")), windowsPathDrive
}

type windowsPathKind int

const (
	windowsPathRelative windowsPathKind = iota
	windowsPathRooted
	windowsPathDriveRelative
	windowsPathDrive
	windowsPathUNC
)

// splitWindows decomposes a Windows path without using filepath.
//
// Hand-written because `filepath` on a Linux build knows nothing about drive
// letters, and this must give the same answer on both builds. Forward slashes
// are accepted throughout: Windows accepts them, people paste them, and Docker
// prints them.
func splitWindows(p string) (volume string, parts []string, kind windowsPathKind) {
	s := strings.ReplaceAll(p, "/", `\`)

	// UNC: \\server\share\...
	if strings.HasPrefix(s, `\\`) {
		rest := cleanParts(strings.Split(strings.TrimPrefix(s, `\\`), `\`))
		if len(rest) < 2 {
			// \\server with no share names no directory.
			return "", nil, windowsPathRooted
		}
		return `\\` + rest[0] + `\` + rest[1], rest[2:], windowsPathUNC
	}

	if len(s) >= 2 && s[1] == ':' && isDriveLetter(s[0]) {
		volume = s[:2]
		rest := s[2:]
		if !strings.HasPrefix(rest, `\`) {
			// C:Media — drive-relative, not absolute.
			return volume, cleanParts(strings.Split(rest, `\`)), windowsPathDriveRelative
		}
		return volume, cleanParts(strings.Split(rest, `\`)), windowsPathDrive
	}

	if strings.HasPrefix(s, `\`) {
		return "", cleanParts(strings.Split(s, `\`)), windowsPathRooted
	}
	return "", cleanParts(strings.Split(s, `\`)), windowsPathRelative
}

func isDriveLetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// cleanParts drops empty and "." components, so a doubled or trailing
// separator does not become a component that compares unequal.
func cleanParts(in []string) []string {
	out := make([]string, 0, len(in))
	for _, p := range in {
		if p == "" || p == "." {
			continue
		}
		out = append(out, p)
	}
	return out
}
