package host

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// Runner executes a command and returns its combined output.
//
// Injected so detection is testable without Docker, and so every command the
// installer runs goes through one place that can log it. Arguments are passed as
// a slice and never as a shell string: nothing here builds a command line by
// concatenation, so a path or a hostname from the user cannot become a shell
// operator.
type Runner interface {
	Run(ctx context.Context, name string, args ...string) (string, error)
}

// ExecRunner is the real implementation.
type ExecRunner struct {
	// Timeout bounds every command. A hung `docker info` — which happens when
	// the daemon is wedged rather than absent — must not hang the installer.
	Timeout time.Duration
}

func (e ExecRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	timeout := e.Timeout
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// CommandContext with an argument slice: no shell is involved at any point.
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// DetectDocker inspects the engine.
//
// Three states are distinguished because they have three different remedies:
// not installed (install it), installed but the daemon is down (start it), and
// installed but too old (upgrade it). Collapsing them into "Docker: no" would
// send an operator to reinstall something that only needed `systemctl start`.
func DetectDocker(ctx context.Context, r Runner) DockerInfo {
	info := DockerInfo{}

	// `docker --version` answers from the CLI alone, so it distinguishes "the
	// binary exists" from "the daemon answers" — which the next call tests.
	if _, err := r.Run(ctx, "docker", "--version"); err != nil {
		return info
	}
	info.Installed = true

	// Server version, which requires the daemon. `{{.Server.Version}}` errors
	// out when it cannot connect, which is exactly the signal wanted.
	version, err := r.Run(ctx, "docker", "version", "--format", "{{.Server.Version}}")
	if err != nil || version == "" {
		return info
	}
	info.DaemonRunning = true
	info.Version = firstLine(version)
	info.MeetsMinimum = AtLeast(info.Version, MinDockerVersion)
	return info
}

// DetectCompose inspects the Compose plugin.
//
// Checks the plugin form (`docker compose`) first because that is what the
// repository's documentation and scripts use. The standalone v1 binary is
// detected separately and reported as legacy rather than accepted: it predates
// the Compose Specification and silently ignores `profiles`, so a stack built on
// it would come up without the engine the operator selected and with no error
// to explain why.
func DetectCompose(ctx context.Context, r Runner) ComposeInfo {
	info := ComposeInfo{}

	if out, err := r.Run(ctx, "docker", "compose", "version", "--short"); err == nil && out != "" {
		info.Installed = true
		info.Version = firstLine(out)
		info.MeetsMinimum = AtLeast(info.Version, MinComposeVersion)
		return info
	}

	if out, err := r.Run(ctx, "docker-compose", "--version"); err == nil && out != "" {
		info.Legacy = true
		info.Version = extractVersion(out)
		// Never "meets minimum": the plugin is what this stack needs.
		return info
	}
	return info
}

// extractVersion pulls the first dotted number out of a version banner.
//
// `docker-compose --version` prints prose ("docker-compose version 1.29.2,
// build ..."), so the number has to be found rather than parsed positionally.
func extractVersion(s string) string {
	for _, field := range strings.Fields(s) {
		trimmed := strings.Trim(field, ",vV")
		if len(splitVersion(trimmed)) >= 2 {
			return trimmed
		}
	}
	return ""
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return strings.TrimSpace(s)
}
