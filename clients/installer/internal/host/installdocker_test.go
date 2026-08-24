package host

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// The system check has always printed "Docker: not installed  WILL INSTALL" on
// a distribution it supports. Nothing implemented it, so the promise was
// followed by every docker command failing for want of docker. These cover the
// installation and, as much, the decision to attempt it at all.

type stepRecorder struct {
	failOn   string // substring of the command that should fail
	commands []string
	calls    int
}

func (s *stepRecorder) Run(_ context.Context, name string, args ...string) (string, error) {
	cmd := name + " " + strings.Join(args, " ")
	s.commands = append(s.commands, cmd)
	s.calls++
	if s.failOn != "" && strings.Contains(cmd, s.failOn) {
		return "E: The repository does not have a Release file", errors.New("exit status 100")
	}
	return "", nil
}

func (s *stepRecorder) joined() string { return strings.Join(s.commands, "\n") }

func TestTheRepositoryPathIsDockersDocumentedOne(t *testing.T) {
	r := &stepRecorder{}
	if err := InstallDocker(context.Background(), r, nil); err != nil {
		t.Fatalf("install failed: %v", err)
	}
	all := r.joined()
	for _, want := range []string{
		"apt-get",
		"/etc/apt/keyrings",
		"download.docker.com",
		"docker-ce",
		"docker-compose-plugin",
		"systemctl enable --now docker",
	} {
		if !strings.Contains(all, want) {
			t.Errorf("installation never did %q:\n%s", want, all)
		}
	}
	// A prompt is a hang on an unattended install, not a question.
	if !strings.Contains(all, "DEBIAN_FRONTEND=noninteractive") {
		t.Errorf("apt could stop to ask something:\n%s", all)
	}
	if strings.Contains(all, "get.docker.com") {
		t.Errorf("fell back to the script when the repository worked:\n%s", all)
	}
}

// The failure this actually hits: a distribution newer than Docker's published
// packages, whose codename is simply not in the repository.
func TestAnUnpublishedCodenameFallsBackToDockersScript(t *testing.T) {
	r := &stepRecorder{failOn: "docker-ce"}
	if err := InstallDocker(context.Background(), r, nil); err != nil {
		t.Fatalf("the fallback did not rescue the install: %v", err)
	}
	if !strings.Contains(r.joined(), "get.docker.com") {
		t.Errorf("no fallback was attempted:\n%s", r.joined())
	}
}

func TestBothReasonsSurviveWhenNeitherPathWorks(t *testing.T) {
	// systemctl runs in both paths, so failing it fails both.
	r := &stepRecorder{failOn: "systemctl"}
	err := InstallDocker(context.Background(), r, nil)
	if err == nil {
		t.Fatal("reported success with no Docker installed")
	}
	for _, want := range []string{"repository:", "script:"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error dropped the %s reason: %v", want, err)
		}
	}
}

func TestProgressNamesEveryStep(t *testing.T) {
	var seen []string
	_ = InstallDocker(context.Background(), &stepRecorder{}, func(s string) { seen = append(seen, s) })
	if len(seen) != len(DockerRepoSteps()) {
		t.Errorf("reported %d steps for %d commands", len(seen), len(DockerRepoSteps()))
	}
	for _, s := range seen {
		if strings.TrimSpace(s) == "" {
			t.Error("a step ran with nothing said about it")
		}
	}
}

// Attempting an install is gated on what the operator was shown, so the two can
// never disagree.
func TestInstallIsAttemptedOnlyWhenTheCheckPromisedIt(t *testing.T) {
	promised := &Report{Findings: []Finding{{Label: "Docker", Value: "not installed", Level: LevelAction}}}
	if !promised.NeedsDockerInstalled() {
		t.Error("did not act on its own promise")
	}

	refused := &Report{Findings: []Finding{{Label: "Docker", Value: "not installed", Level: LevelFail}}}
	if refused.NeedsDockerInstalled() {
		t.Error("would install on a distribution it told the operator it could not")
	}

	present := &Report{Docker: DockerInfo{Installed: true}}
	if present.NeedsDockerInstalled() {
		t.Error("would reinstall over a working Docker")
	}
}
