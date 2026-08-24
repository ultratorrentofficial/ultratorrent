package host

import (
	"context"
	"fmt"
	"strings"
)

// DockerInstallStep is one command, with the words to show while it runs.
type DockerInstallStep struct {
	Describe string
	Name     string
	Args     []string
}

// aptNonInteractive prefixes apt so it can never stop for a question.
//
// An installer that pauses on a package's configuration prompt hangs forever on
// an unattended run, and the conffile prompt is the one apt asks most.
var aptNonInteractive = []string{
	"env", "DEBIAN_FRONTEND=noninteractive", "apt-get",
	"-y", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold",
}

func apt(args ...string) (string, []string) {
	full := append(append([]string{}, aptNonInteractive[1:]...), args...)
	return "env", full
}

// DockerRepoSteps is Docker's own documented installation for Debian and
// Ubuntu, in order.
//
// Written out rather than piped from a script so each step can be named while
// it runs and so a failure says which one failed. $ID and the codename are
// resolved by the shell from /etc/os-release, which keeps one list correct for
// both distributions and for derivatives that set VERSION_CODENAME.
func DockerRepoSteps() []DockerInstallStep {
	steps := []DockerInstallStep{}
	add := func(desc, name string, args ...string) {
		steps = append(steps, DockerInstallStep{Describe: desc, Name: name, Args: args})
	}
	n, a := apt("update")
	add("refreshing the package list", n, a...)
	n, a = apt("install", "ca-certificates", "curl")
	add("installing prerequisites", n, a...)
	add("creating the keyring directory", "install", "-m", "0755", "-d", "/etc/apt/keyrings")
	add("fetching Docker's signing key", "sh", "-c",
		`. /etc/os-release; curl -fsSL "https://download.docker.com/linux/${ID}/gpg" `+
			`-o /etc/apt/keyrings/docker.asc`)
	add("making the key readable", "chmod", "a+r", "/etc/apt/keyrings/docker.asc")
	add("adding Docker's package repository", "sh", "-c",
		`. /etc/os-release; codename="${VERSION_CODENAME:-$UBUNTU_CODENAME}"; `+
			`echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] `+
			`https://download.docker.com/linux/${ID} ${codename} stable" `+
			`> /etc/apt/sources.list.d/docker.list`)
	n, a = apt("update")
	add("refreshing the package list", n, a...)
	n, a = apt("install", "docker-ce", "docker-ce-cli", "containerd.io",
		"docker-buildx-plugin", "docker-compose-plugin")
	add("installing Docker Engine and the Compose plugin", n, a...)
	add("starting Docker", "systemctl", "enable", "--now", "docker")
	return steps
}

// convenienceScript is Docker's official get.docker.com installer.
//
// The fallback, not the first choice. It is Docker's own script and it knows
// about releases whose codename is not yet in the package repository — which is
// the failure the repository path actually hits: a distribution released before
// Docker publishes packages for it. Downloaded and then run, rather than piped
// straight into a shell, so a truncated download cannot execute as far as it got.
var convenienceScript = []DockerInstallStep{
	{Describe: "downloading Docker's installation script", Name: "sh", Args: []string{"-c",
		"curl -fsSL https://get.docker.com -o /tmp/get-docker.sh"}},
	{Describe: "running Docker's installation script", Name: "sh", Args: []string{
		"/tmp/get-docker.sh"}},
	{Describe: "starting Docker", Name: "systemctl", Args: []string{"enable", "--now", "docker"}},
}

// InstallDocker installs Docker Engine and the Compose plugin.
//
// Two paths, tried in order. The repository path is Docker's documented
// installation and the one to prefer: pinned to a signed repository, and it
// leaves the host able to receive updates through apt like everything else. It
// fails on a distribution newer than Docker's published packages — the codename
// simply is not there — and that is not a reason to stop, because Docker's own
// convenience script handles exactly that case.
//
// Anything left behind by a half-finished first attempt is harmless to the
// second: the script reads the same repository state and completes it.
func InstallDocker(ctx context.Context, run Runner, progress func(string)) error {
	// Progress is optional, so every use goes through this rather than each
	// caller remembering to check — the fallback below forgot once already.
	say := func(s string) {
		if progress != nil {
			progress(s)
		}
	}
	repoErr := runSteps(ctx, run, DockerRepoSteps(), say)
	if repoErr == nil {
		return nil
	}
	say("the package repository did not work (" + firstLineOf(repoErr.Error()) +
		"), falling back to Docker's installation script")
	if err := runSteps(ctx, run, convenienceScript, say); err != nil {
		// Both reasons, because the first is usually the informative one and
		// the second alone would send an operator looking in the wrong place.
		return fmt.Errorf("could not install Docker.\n  repository: %v\n  script: %v", repoErr, err)
	}
	return nil
}

func runSteps(ctx context.Context, run Runner, steps []DockerInstallStep, progress func(string)) error {
	for _, s := range steps {
		if progress != nil {
			progress(s.Describe)
		}
		if out, err := run.Run(ctx, s.Name, s.Args...); err != nil {
			return fmt.Errorf("%s: %s", s.Describe, firstLineOf(out+" "+err.Error()))
		}
	}
	return nil
}

// firstLineOf keeps a failure to one line for a progress display.
func firstLineOf(s string) string {
	for _, line := range strings.Split(s, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			return line
		}
	}
	return "no output"
}
