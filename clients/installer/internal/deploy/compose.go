// Package deploy runs Docker Compose.
//
// This is the first part of the installer that changes a running system, so the
// rules it enforces are stated rather than assumed:
//
//   - The project name is ALWAYS explicit. Compose otherwise derives it from the
//     project directory, and on a host that already runs UltraTorrent from the
//     same checkout that means silently attaching to the operator's existing
//     stack and reconfiguring it. Nothing else here matters as much.
//   - Nothing removes a volume, ever. `down -v` would destroy the database and
//     the media tree; no code path constructs it, and a test asserts that.
//   - Images are built through `ops/scripts/docker-build.sh`, never a bare
//     `docker compose build`, so the git commit is stamped into the image and
//     `build-info.json` can say what is running.
//   - Every failure is diagnosed before it is reported. "The stack did not come
//     up" is not an answer an operator can act on; which container failed, and
//     what its last lines said, is.
package deploy

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Runner executes a command. Injected so the argv this package builds — the part
// that matters — is testable without a Docker daemon.
type Runner func(ctx context.Context, name string, args ...string) (stdout string, stderr string, err error)

// Compose invokes Docker Compose against one installation.
type Compose struct {
	// RepoDir holds docker-compose.yml. It is also the project directory, so the
	// build contexts and any remaining relative paths resolve as they do when the
	// operator runs Compose by hand.
	RepoDir string
	// InstallDir holds the generated .env and override.
	InstallDir string
	// ProjectName isolates this installation. Required — see the package comment.
	ProjectName string
	// Profiles are passed explicitly as well as being written to .env, because a
	// command must not depend on a file it did not read.
	Profiles []string
	// HasOverride records whether this installation generated an override. A plan
	// that specialises nothing produces none, and passing `-f` for a file that
	// does not exist is an error rather than a no-op.
	HasOverride bool

	Run Runner
}

// Files the executor references inside the installation directory.
const (
	EnvFile      = ".env"
	OverrideFile = "docker-compose.override.yml"
	BaseFile     = "docker-compose.yml"
)

// baseArgs builds the invariant part of every Compose command.
//
// The two `-f` flags are explicit on purpose. With them Compose does NOT
// auto-load a `docker-compose.override.yml` sitting in the repository — which on
// a host already running UltraTorrent is the live deployment's own override, and
// merging it into a fresh installation would produce a stack that is neither.
func (c *Compose) baseArgs() ([]string, error) {
	if c.ProjectName == "" {
		// Refused rather than defaulted. A derived project name is how an
		// installer ends up adopting a stack it did not create.
		return nil, fmt.Errorf("a Compose project name is required; without one " +
			"Compose derives it from the directory and may attach to an existing stack")
	}
	if c.RepoDir == "" || c.InstallDir == "" {
		return nil, fmt.Errorf("both the repository and installation directories are required")
	}
	args := []string{
		"compose",
		"--project-name", c.ProjectName,
		"--project-directory", c.RepoDir,
		"-f", c.RepoDir + "/" + BaseFile,
	}
	if c.HasOverride {
		args = append(args, "-f", c.InstallDir+"/"+OverrideFile)
	}
	args = append(args, "--env-file", c.InstallDir+"/"+EnvFile)
	for _, profile := range c.Profiles {
		args = append(args, "--profile", profile)
	}
	return args, nil
}

// Config validates the merged configuration without changing anything.
//
// Run first, always. It catches a malformed override, a missing required
// variable and an unresolvable path in a second, before any container is
// created — the same failures cost minutes to diagnose once half a stack is up.
func (c *Compose) Config(ctx context.Context) error {
	args, err := c.baseArgs()
	if err != nil {
		return err
	}
	_, stderr, err := c.Run(ctx, "docker", append(args, "config", "--quiet")...)
	if err != nil {
		return fmt.Errorf("the generated configuration is not valid: %s", firstLine(stderr))
	}
	return nil
}

// Pull fetches the third-party images.
//
// Separate from Up so a slow download is never mistaken for a slow start — and
// so a registry problem is reported as a registry problem. Failure is not fatal:
// an image already present locally is enough, and an installation on a host with
// no outbound access to Docker Hub should still start.
func (c *Compose) Pull(ctx context.Context) (string, error) {
	args, err := c.baseArgs()
	if err != nil {
		return "", err
	}
	// --ignore-buildable: the backend and frontend have no published image, only
	// a build context. Asking a registry for them would fail every time.
	_, stderr, err := c.Run(ctx, "docker", append(args, "pull", "--ignore-buildable")...)
	if err != nil {
		return firstLine(stderr), err
	}
	return "", nil
}

// Up starts the stack and waits for it to become healthy.
//
// `--wait` rather than a poll of our own: every image here carries a HEALTHCHECK
// (the backend's hits /api/system/live), so Compose already knows what healthy
// means for each service and will fail if a container exits or goes unhealthy.
// Reimplementing that would mean deciding readiness from the outside and getting
// it subtly different from what the images themselves declare.
//
// No --force-recreate, no --renew-anon-volumes, no -V. On a re-run this must be
// the no-op it looks like.
func (c *Compose) Up(ctx context.Context, wait time.Duration) error {
	args, err := c.baseArgs()
	if err != nil {
		return err
	}
	args = append(args, "up", "--detach", "--wait",
		"--wait-timeout", fmt.Sprintf("%d", int(wait.Seconds())))
	_, stderr, err := c.Run(ctx, "docker", args...)
	if err != nil {
		return fmt.Errorf("the stack did not come up: %s", firstLine(stderr))
	}
	return nil
}

// Stop stops the containers, leaving volumes and networks intact.
//
// Deliberately `stop` and not `down`. `down` removes containers and networks and,
// with -v, the volumes — which here means the database and the media tree. There
// is no flag this package passes that can delete data.
func (c *Compose) Stop(ctx context.Context) error {
	args, err := c.baseArgs()
	if err != nil {
		return err
	}
	_, stderr, err := c.Run(ctx, "docker", append(args, "stop")...)
	if err != nil {
		return fmt.Errorf("stopping the stack: %s", firstLine(stderr))
	}
	return nil
}

// ServiceStatus is one container's state.
type ServiceStatus struct {
	Service string `json:"Service"`
	Name    string `json:"Name"`
	State   string `json:"State"`
	Health  string `json:"Health"`
	Exit    int    `json:"ExitCode"`
}

// Healthy reports whether a service is running and, if it declares a health
// check, passing it. A service with no health check is judged on running alone —
// treating "no opinion" as unhealthy would fail every stack with a plain image.
func (s ServiceStatus) Healthy() bool {
	if s.State != "running" {
		return false
	}
	return s.Health == "" || s.Health == "healthy"
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "no output"
	}
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
