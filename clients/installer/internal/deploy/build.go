package deploy

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// BuildScript is the repository's canonical image build.
//
// Called rather than reimplemented, and a bare `docker compose build` is never
// issued. The script stamps the git commit, tag and build time into the image so
// `build-info.json` can report exactly what is running — two deployments can
// share a version number and differ by commit, and without the stamp there is no
// way to tell them apart. The project's own rules require this path, and a
// pre-commit hook enforces it.
const BuildScript = "ops/scripts/docker-build.sh"

// BuildableServices are the images this repository builds rather than pulls.
//
// They have a `build:` section and no published image, which is also why `pull`
// is invoked with --ignore-buildable: asking a registry for them fails every
// time.
var BuildableServices = []string{"backend", "frontend"}

// NeedsBuild reports whether the repository can build images here.
//
// The installer cannot invent a way around a missing build script: with no
// published image for the backend or frontend, a checkout without it cannot
// produce a running stack at all. Saying so plainly beats failing later inside
// Compose.
func (c *Compose) NeedsBuild() (script string, ok bool) {
	script = filepath.Join(c.RepoDir, BuildScript)
	if info, err := os.Stat(script); err != nil || info.IsDir() {
		return script, false
	}
	return script, true
}

// Build produces the application images through the canonical script.
func (c *Compose) Build(ctx context.Context) error {
	script, ok := c.NeedsBuild()
	if !ok {
		return fmt.Errorf(
			"%s is missing, and this repository publishes no image for %v — "+
				"an installation cannot be built from this checkout",
			script, BuildableServices)
	}
	args := append([]string{}, BuildableServices...)
	_, stderr, err := c.Run(ctx, script, args...)
	if err != nil {
		return fmt.Errorf("building the application images failed: %s", firstLine(stderr))
	}
	return nil
}
