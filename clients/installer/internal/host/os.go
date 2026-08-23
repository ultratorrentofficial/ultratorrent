package host

import (
	"fmt"
	"runtime"
	"strconv"
	"strings"
)

// ParseOSRelease reads the key=value format of /etc/os-release.
//
// Hand-parsed rather than pulled from a dependency: the format is three rules
// (comments, `KEY=value`, optionally quoted) and a distribution-detection bug is
// far easier to find in ten lines here than in someone else's parser.
func ParseOSRelease(content string) map[string]string {
	values := map[string]string{}
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		value = strings.TrimSpace(value)
		// Values may be quoted with either mark; unquote only a matched pair so
		// an apostrophe inside a pretty name survives.
		if len(value) >= 2 {
			if (value[0] == '"' && value[len(value)-1] == '"') ||
				(value[0] == '\'' && value[len(value)-1] == '\'') {
				value = value[1 : len(value)-1]
			}
		}
		values[strings.TrimSpace(key)] = value
	}
	return values
}

// SupportedDistros are the first release's targets, per the brief.
//
// A short list on purpose. "Supported" here means the Docker installation path
// is the official one for that distribution and has been exercised; it is not a
// claim about every apt-based system.
var SupportedDistros = map[string]string{
	"ubuntu": "Ubuntu",
	"debian": "Debian",
}

// DetectOS classifies a host from its os-release contents.
//
// An unsupported distribution is NOT a failure by itself. The installer's real
// requirement is Docker, and a Fedora or Arch host with Docker already running
// can deploy this stack perfectly well — what it cannot do is have the installer
// install Docker for it. That distinction is drawn in Detect(), where Docker's
// state is known; here we only record what the machine is.
func DetectOS(osRelease string) OSInfo {
	values := ParseOSRelease(osRelease)
	info := OSInfo{
		ID:        strings.ToLower(values["ID"]),
		VersionID: values["VERSION_ID"],
		Name:      values["PRETTY_NAME"],
	}
	if info.Name == "" {
		info.Name = values["NAME"]
	}
	if info.Name == "" && info.ID != "" {
		info.Name = info.ID
	}

	// ID_LIKE catches derivatives — Linux Mint reports `ID=linuxmint` with
	// `ID_LIKE=ubuntu`, and Raspberry Pi OS reports `ID_LIKE=debian`. Treating
	// those as their base is right for Docker installation, which is what
	// "supported" governs.
	if _, ok := SupportedDistros[info.ID]; ok {
		info.Supported = true
	} else {
		for _, like := range strings.Fields(values["ID_LIKE"]) {
			if _, ok := SupportedDistros[strings.ToLower(like)]; ok {
				info.Supported = true
				break
			}
		}
	}
	return info
}

// DetectArch maps the running architecture to Docker's naming.
func DetectArch() Arch {
	switch runtime.GOARCH {
	case "amd64":
		return ArchAMD64
	case "arm64":
		return ArchARM64
	default:
		return ArchOther
	}
}

// ParseMemTotal pulls MemTotal out of /proc/meminfo, in bytes.
//
// /proc/meminfo reports kibibytes despite the `kB` label — a long-standing
// Linux quirk. Multiplying by 1024 rather than 1000 is deliberate and is why
// this has its own test.
func ParseMemTotal(meminfo string) (int64, error) {
	for _, line := range strings.Split(meminfo, "\n") {
		if !strings.HasPrefix(line, "MemTotal:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0, fmt.Errorf("malformed MemTotal line: %q", line)
		}
		kib, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("unreadable MemTotal value %q: %w", fields[1], err)
		}
		return kib * 1024, nil
	}
	return 0, fmt.Errorf("no MemTotal line in meminfo")
}

// CompareVersions orders two dotted version strings.
//
// Returns -1, 0 or 1. Compares numeric components pairwise and stops caring at
// the first difference, so "27.1.2" > "20.10" without needing either to be
// well-formed semver — Docker's own versions are not. A non-numeric component
// (a distribution suffix like "20.10.7-0ubuntu1") stops the comparison rather
// than failing it: everything meaningful has already been compared by then.
func CompareVersions(a, b string) int {
	as, bs := splitVersion(a), splitVersion(b)
	for i := 0; i < len(as) || i < len(bs); i++ {
		var x, y int
		if i < len(as) {
			x = as[i]
		}
		if i < len(bs) {
			y = bs[i]
		}
		switch {
		case x < y:
			return -1
		case x > y:
			return 1
		}
	}
	return 0
}

func splitVersion(v string) []int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	parts := strings.Split(v, ".")
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		// Trim any trailing non-digits: "10-rc1" compares as 10.
		digits := strings.Builder{}
		for _, r := range p {
			if r < '0' || r > '9' {
				break
			}
			digits.WriteRune(r)
		}
		if digits.Len() == 0 {
			break
		}
		n, err := strconv.Atoi(digits.String())
		if err != nil {
			break
		}
		out = append(out, n)
	}
	return out
}

// AtLeast reports whether version >= minimum.
func AtLeast(version, minimum string) bool {
	if version == "" {
		return false
	}
	return CompareVersions(version, minimum) >= 0
}
