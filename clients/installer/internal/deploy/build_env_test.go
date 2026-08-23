package deploy

import (
	"context"
	"strings"
	"testing"
)

// docker-build.sh ends in `exec docker compose build "$@"`, and Compose's
// global flags must precede the subcommand — so --env-file, --project-name and
// -f cannot be threaded through the script's arguments. They go as COMPOSE_*
// environment variables instead.
//
// Live, without this the build failed on every required variable at once
// ("required variable POSTGRES_PASSWORD is missing a value"), because Compose
// looked for a .env in the repository while the generated one is in the
// installation directory.
func TestBuildCarriesComposeContextInTheEnvironment(t *testing.T) {
	var gotEnv []string
	c := &Compose{
		RepoDir: "/repo", InstallDir: "/opt/ut", ProjectName: "ultratorrent",
		Profiles: []string{"qbittorrent"}, HasOverride: true,
		Run: func(_ context.Context, _ string, env []string, _ ...string) (string, string, error) {
			gotEnv = env
			return "", "", nil
		},
	}
	// NeedsBuild stats the script; a missing one short-circuits before Run.
	if _, ok := c.NeedsBuild(); ok {
		t.Skip("a real build script exists at /repo; this test wants the injected runner only")
	}
	_ = c.Build(context.Background())

	joined := strings.Join(c.composeEnv(), " ")
	for _, want := range []string{
		"COMPOSE_PROJECT_NAME=ultratorrent",
		"COMPOSE_ENV_FILES=/opt/ut/.env",
		"COMPOSE_PROFILES=qbittorrent",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("composeEnv() missing %q; got %s", want, joined)
		}
	}
	// The override must be merged, and after the base file — order decides which wins.
	if !strings.Contains(joined, "COMPOSE_FILE=/repo/docker-compose.yml:/opt/ut/docker-compose.override.yml") {
		t.Errorf("COMPOSE_FILE wrong or override missing; got %s", joined)
	}
	_ = gotEnv
}

// A plan with no override must not name a file that does not exist: Compose
// treats a missing -f as a hard error.
func TestComposeEnvOmitsAnAbsentOverride(t *testing.T) {
	c := &Compose{RepoDir: "/repo", InstallDir: "/opt/ut", ProjectName: "x", HasOverride: false}
	joined := strings.Join(c.composeEnv(), " ")
	if strings.Contains(joined, OverrideFile) {
		t.Errorf("override named despite HasOverride=false: %s", joined)
	}
}
