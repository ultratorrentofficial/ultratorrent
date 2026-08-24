package deploy

import (
	"context"
	"strings"
)

// StampEnv is the build argument the build script bakes into the backend image.
//
// docker-build.sh exports GIT_SHA and Compose passes it as a build arg, so the
// image records the commit it was built from and `docker image inspect` can read
// it back without starting a container.
const StampEnv = "GIT_SHA="

// imageName is what Compose calls an image it builds for a service.
func (c *Compose) imageName(service string) string {
	return strings.ToLower(c.ProjectName) + "-" + service + ":latest"
}

// imageEnv reads one environment entry from a built image, if the image exists.
func (c *Compose) imageEnv(ctx context.Context, service, prefix string) (value string, imageExists bool) {
	stdout, _, err := c.Run(ctx, "docker", nil, "image", "inspect",
		c.imageName(service), "--format", "{{range .Config.Env}}{{println .}}{{end}}")
	if err != nil {
		return "", false
	}
	for _, line := range strings.Split(stdout, "\n") {
		if line = strings.TrimSpace(line); strings.HasPrefix(line, prefix) {
			return strings.TrimPrefix(line, prefix), true
		}
	}
	return "", true
}

// git runs a read-only git command in the checkout.
func (c *Compose) git(ctx context.Context, args ...string) (string, bool) {
	full := append([]string{"-C", c.RepoDir}, args...)
	stdout, _, err := c.Run(ctx, "git", nil, full...)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(stdout), true
}

// ImagesAreCurrent reports whether the built images already correspond to this
// checkout, and why not when they do not.
//
// Rebuilding on every deployment is the safe default and it is expensive: the
// build script stamps build-info.json with a fresh timestamp, which is COPYed
// into the image, so the layer cache is invalidated by design and every run is
// a full rebuild. Skipping needs a rule that cannot be wrong in the direction
// that matters, because the failure it risks — deploying a stale image while
// reporting success — is worse than the minutes it saves.
//
// The rule is that identical source produces an identical image, so a build is
// skipped only when ALL of these hold:
//
//   - The checkout is a git repository with a resolvable HEAD. No HEAD, no
//     identity, no skipping.
//   - The working tree is CLEAN. Uncommitted changes are invisible to the
//     commit and are exactly what someone testing a change has; skipping there
//     would deploy the previous commit and say nothing.
//   - The backend image exists and records that same commit. It is stamped by
//     the build script and is the only durable identity either image carries.
//   - The frontend image exists at all. It carries no stamp of its own, so
//     existence is all that can be checked; both images are always built
//     together, so a missing one means the pair is incomplete.
//
// Anything unknown answers "not current" and builds. Every uncertainty resolves
// towards doing the work.
func (c *Compose) ImagesAreCurrent(ctx context.Context) (current bool, reason string) {
	head, ok := c.git(ctx, "rev-parse", "HEAD")
	if !ok || head == "" {
		return false, "this checkout has no resolvable git commit"
	}
	dirty, ok := c.git(ctx, "status", "--porcelain")
	if !ok {
		return false, "the checkout's state could not be read"
	}
	if dirty != "" {
		return false, "the checkout has uncommitted changes"
	}

	sha, exists := c.imageEnv(ctx, "backend", StampEnv)
	switch {
	case !exists:
		return false, "no backend image has been built here yet"
	case sha == "":
		return false, "the backend image records no commit"
	case sha != head:
		return false, "the images were built from a different commit"
	}

	if _, exists := c.imageEnv(ctx, "frontend", StampEnv); !exists {
		return false, "the frontend image is missing"
	}
	return true, "built from this commit, and the checkout is clean"
}
