package deploy

import (
	"context"
	"strings"
	"testing"
	"time"
)

// recorder captures every argv this package builds.
type recorder struct {
	calls  [][]string
	stdout string
	err    error
}

func (r *recorder) run() Runner {
	return func(_ context.Context, name string, _ []string, args ...string) (string, string, error) {
		r.calls = append(r.calls, append([]string{name}, args...))
		return r.stdout, "", r.err
	}
}

func (r *recorder) flat() string {
	var b strings.Builder
	for _, call := range r.calls {
		b.WriteString(strings.Join(call, " ") + "\n")
	}
	return b.String()
}

func testCompose(r *recorder) *Compose {
	return &Compose{
		RepoDir: "/repo", InstallDir: "/opt/ut", ProjectName: "ultratorrent",
		Profiles: []string{"qbittorrent"}, HasOverride: true, Run: r.run(),
	}
}

func TestTheProjectNameIsAlwaysExplicit(t *testing.T) {
	/*
	 * The single most dangerous thing this package could get wrong. Compose
	 * derives the project name from the project directory, so on a host already
	 * running UltraTorrent from the same checkout an implicit name means
	 * silently attaching to the operator's existing stack and reconfiguring it.
	 */
	r := &recorder{}
	c := testCompose(r)
	if err := c.Config(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.flat(), "--project-name ultratorrent") {
		t.Errorf("every command must name its project:\n%s", r.flat())
	}
}

func TestAMissingProjectNameIsRefused(t *testing.T) {
	// Refused rather than defaulted: a derived name is how an installer adopts a
	// stack it did not create.
	r := &recorder{}
	c := testCompose(r)
	c.ProjectName = ""
	if err := c.Config(context.Background()); err == nil {
		t.Fatal("expected a refusal")
	}
	if len(r.calls) != 0 {
		t.Errorf("nothing should have run: %v", r.calls)
	}
}

func TestNoCommandCanDestroyData(t *testing.T) {
	/*
	 * The volumes here are the database and the media tree. Removing them would
	 * be unrecoverable, and no amount of care elsewhere makes up for one code
	 * path that constructs such a command. This drives every operation the
	 * package offers and inspects the resulting argv.
	 */
	r := &recorder{stdout: "[]"}
	c := testCompose(r)
	ctx := context.Background()

	_ = c.Config(ctx)
	_, _ = c.Pull(ctx)
	_ = c.Up(ctx, time.Minute)
	_ = c.Stop(ctx)
	_, _ = c.Status(ctx)
	_, _ = c.Logs(ctx, "backend", 20)

	forbidden := []string{"down", "--volumes", "-v", "rm", "--force-recreate",
		"--renew-anon-volumes", "prune", "kill"}
	for _, call := range r.calls {
		for _, arg := range call {
			for _, bad := range forbidden {
				if arg == bad {
					t.Errorf("a command used %q: %v", bad, call)
				}
			}
		}
	}
}

func TestUpWaitsOnTheImagesOwnHealthChecks(t *testing.T) {
	// Every image here declares one — the backend's hits /api/system/live — so
	// Compose already knows what healthy means per service. Polling from outside
	// would mean inventing a definition that differs from the images'.
	r := &recorder{}
	c := testCompose(r)
	if err := c.Up(context.Background(), 90*time.Second); err != nil {
		t.Fatal(err)
	}
	flat := r.flat()
	for _, want := range []string{"up", "--detach", "--wait", "--wait-timeout 90"} {
		if !strings.Contains(flat, want) {
			t.Errorf("missing %q in:\n%s", want, flat)
		}
	}
}

func TestBothComposeFilesArePassedExplicitly(t *testing.T) {
	/*
	 * With explicit -f flags Compose does NOT auto-load a
	 * docker-compose.override.yml sitting in the repository — which on a host
	 * already running UltraTorrent is the LIVE deployment's override. Merging it
	 * into a fresh installation would produce a stack that is neither.
	 */
	r := &recorder{}
	c := testCompose(r)
	_ = c.Config(context.Background())
	flat := r.flat()
	if !strings.Contains(flat, "-f /repo/docker-compose.yml") {
		t.Errorf("the base file should be explicit:\n%s", flat)
	}
	if !strings.Contains(flat, "-f /opt/ut/docker-compose.override.yml") {
		t.Errorf("the generated override should be explicit:\n%s", flat)
	}
	if !strings.Contains(flat, "--env-file /opt/ut/.env") {
		t.Errorf("the generated env file should be explicit:\n%s", flat)
	}
}

func TestAnAbsentOverrideIsNotPassed(t *testing.T) {
	// A plan that specialises nothing generates none, and `-f` for a file that
	// does not exist is an error rather than a no-op.
	r := &recorder{}
	c := testCompose(r)
	c.HasOverride = false
	_ = c.Config(context.Background())
	if strings.Contains(r.flat(), "docker-compose.override.yml") {
		t.Errorf("an override that was never generated must not be passed:\n%s", r.flat())
	}
}

func TestProfilesArePassedAsWellAsWritten(t *testing.T) {
	// A command must not depend on a file it did not read: .env carries
	// COMPOSE_PROFILES for the operator's later commands, but this one says it.
	r := &recorder{}
	c := testCompose(r)
	_ = c.Config(context.Background())
	if !strings.Contains(r.flat(), "--profile qbittorrent") {
		t.Errorf("profiles should be explicit:\n%s", r.flat())
	}
}

func TestPullSkipsImagesThatDoNotExist(t *testing.T) {
	// backend and frontend have a build context and no published image; asking a
	// registry for them fails every time.
	r := &recorder{}
	c := testCompose(r)
	_, _ = c.Pull(context.Background())
	if !strings.Contains(r.flat(), "--ignore-buildable") {
		t.Errorf("pull should ignore buildable services:\n%s", r.flat())
	}
}

func TestImagesAreOnlyProducedByTheCanonicalScript(t *testing.T) {
	/*
	 * Building outside the repository's script leaves the image unstamped, so
	 * nothing can report which commit is running — two deployments can share a
	 * version number and differ by commit. The project requires that path and a
	 * hook enforces it.
	 */
	r := &recorder{}
	c := testCompose(r)
	c.RepoDir = t.TempDir()
	// With no script present it must refuse rather than fall back.
	if err := c.Build(context.Background()); err == nil {
		t.Fatal("expected a refusal when the build script is missing")
	}
	// Checked structurally rather than as a phrase: no invocation may ask
	// Compose to produce images itself.
	for _, call := range r.calls {
		if contains(call, "compose") && contains(call, "build") {
			t.Errorf("an unstamped image build was issued: %v", call)
		}
	}
}

// --- status parsing --------------------------------------------------------

func TestStatusReadsBothComposeFormats(t *testing.T) {
	/*
	 * Compose emits one JSON object PER LINE, and has emitted an array in other
	 * versions. Guessing wrong leaves the diagnosis silently empty at exactly the
	 * moment it is needed.
	 */
	lines := `{"Service":"backend","State":"running","Health":"healthy"}
{"Service":"postgres","State":"exited","ExitCode":1}`
	got, err := parseStatus(lines)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("parsed %d services from newline JSON", len(got))
	}

	array := `[{"Service":"backend","State":"running","Health":"healthy"}]`
	got, err = parseStatus(array)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("parsed %d services from array JSON", len(got))
	}
}

func TestOneUnreadableLineDoesNotLoseTheRest(t *testing.T) {
	got, err := parseStatus("{\"Service\":\"a\",\"State\":\"running\"}\nnot json\n{\"Service\":\"b\",\"State\":\"exited\"}")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Errorf("expected the readable lines to survive, got %d", len(got))
	}
}

func TestAServiceWithNoHealthCheckIsJudgedOnRunning(t *testing.T) {
	// Treating "no opinion" as unhealthy would fail every stack built on a plain
	// image.
	if !(ServiceStatus{State: "running"}).Healthy() {
		t.Error("a running service with no health check is healthy")
	}
	if (ServiceStatus{State: "running", Health: "starting"}).Healthy() {
		t.Error("still starting is not yet healthy")
	}
	if (ServiceStatus{State: "exited", Exit: 1}).Healthy() {
		t.Error("an exited service is not healthy")
	}
}

func TestDiagnosisRedactsSecretsFromLogs(t *testing.T) {
	/*
	 * A backend that cannot reach its database prints DATABASE_URL, password
	 * included. This output is destined for a terminal an operator will
	 * screenshot into an issue.
	 */
	const password = "SUPERSECRETPASSWORD"
	c := testCompose(&recorder{})
	c.Run = func(_ context.Context, name string, _ []string, args ...string) (string, string, error) {
		if contains(args, "ps") {
			return `{"Service":"backend","State":"exited","ExitCode":1}`, "", nil
		}
		return "connect failed: postgresql://ultratorrent:" + password + "@postgres:5432", "", nil
	}
	d := c.Diagnose(context.Background(), 20, func(s string) string {
		return strings.ReplaceAll(s, password, "********")
	})
	if d.Empty() {
		t.Fatal("an exited backend should be diagnosed")
	}
	if strings.Contains(d.String(), password) {
		t.Fatalf("the diagnosis leaked a password:\n%s", d.String())
	}
	if !strings.Contains(d.String(), "exit code 1") {
		t.Errorf("it should say how the container ended:\n%s", d.String())
	}
}

func TestHealthyStackProducesNoDiagnosis(t *testing.T) {
	c := testCompose(&recorder{})
	c.Run = func(_ context.Context, _ string, _ []string, args ...string) (string, string, error) {
		return `{"Service":"backend","State":"running","Health":"healthy"}`, "", nil
	}
	if !c.Diagnose(context.Background(), 20, nil).Empty() {
		t.Error("a healthy stack has nothing to diagnose")
	}
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
