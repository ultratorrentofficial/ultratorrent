package deploy

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// The backend applies migrations at startup and does not seed, so a new
// installation comes up with a complete schema and an empty users table: every
// container healthy, every sign-in refused. These cover the step that closes
// that gap, and the handling of the password it prints.

type scriptedRunner struct {
	stdout, stderr string
	err            error
	gotArgs        []string
	gotEnv         []string
}

func (r *scriptedRunner) run() Runner {
	return func(_ context.Context, _ string, env []string, args ...string) (string, string, error) {
		r.gotArgs = args
		r.gotEnv = env
		return r.stdout, r.stderr, r.err
	}
}

func seedCompose(r *scriptedRunner) *Compose {
	return &Compose{
		RepoDir: "/repo", InstallDir: "/opt/ut", ProjectName: "ultratorrent",
		Profiles: []string{"qbittorrent"}, HasOverride: true, Run: r.run(),
	}
}

// The real seed ends by printing the administrator's password. The installer
// has already written it to a root-only file, so returning it to the caller —
// rather than printing it — is what keeps it off the terminal.
const realSeedOutput = `
> @ultratorrent/backend@0.85.9 prisma:seed
> ts-node prisma/seed.ts

(node:1830) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type not specified
Seed complete. Super admin: admin / RKEuqhVsfydPqRPNIwhD06BP
`

func TestSeedRunsInTheBackendWithoutATTY(t *testing.T) {
	r := &scriptedRunner{stdout: realSeedOutput}
	if _, err := seedCompose(r).Seed(context.Background()); err != nil {
		t.Fatalf("seed failed: %v", err)
	}
	joined := strings.Join(r.gotArgs, " ")
	for _, want := range []string{"exec", "-T", BackendService, seedCommand} {
		if !strings.Contains(joined, want) {
			t.Errorf("seed command missing %q: %s", want, joined)
		}
	}
	// Without -T Compose tries to allocate a TTY, which fails on every
	// unattended install — the runner gives its child no stdin at all.
	if strings.Contains(joined, "exec -it") {
		t.Errorf("asked for a TTY: %s", joined)
	}
}

func TestSeedFailureCarriesOutputBackForTheCallerToRedact(t *testing.T) {
	r := &scriptedRunner{
		stdout: "partial\n",
		stderr: "Error: P1001 cannot reach database server\n",
		err:    errors.New("exit status 1"),
	}
	out, err := seedCompose(r).Seed(context.Background())
	if err == nil {
		t.Fatal("a failed seed reported success")
	}
	if !strings.Contains(err.Error(), "P1001") {
		t.Errorf("the reason did not reach the error: %v", err)
	}
	if !strings.Contains(out, "P1001") {
		t.Errorf("stderr was dropped, leaving nothing to print: %q", out)
	}
}

// Node prints its warnings first, so the answer is the LAST line, not the first.
func TestSignInAnswerIsReadFromTheEndOfTheOutput(t *testing.T) {
	r := &scriptedRunner{stdout: "(node:12) Warning: something\n201 TOKEN\n"}
	ok, _, known := seedCompose(r).SignInWorks(context.Background())
	if !ok || !known {
		t.Errorf("a successful sign-in was not recognised (ok=%v known=%v)", ok, known)
	}
}

func TestARefusedSignInIsKnownAndNotOK(t *testing.T) {
	r := &scriptedRunner{stdout: "401 NOTOKEN\n"}
	ok, detail, known := seedCompose(r).SignInWorks(context.Background())
	if ok {
		t.Error("a 401 was reported as a working sign-in")
	}
	if !known {
		t.Error("a definite refusal was reported as unknown")
	}
	if !strings.Contains(detail, "401") {
		t.Errorf("detail lost the status: %q", detail)
	}
}

// "Could not ask" must never read as either answer: reporting it as success
// hides the broken install this step exists to catch, and reporting it as
// failure would fail deployments over a probe that could not run.
func TestAnUnaskableQuestionIsNeitherPassNorFail(t *testing.T) {
	for name, r := range map[string]*scriptedRunner{
		"exec failed":    {err: errors.New("exit status 126")},
		"no password":    {stdout: "SKIP no-admin-password-in-environment\n"},
		"empty response": {stdout: "\n"},
	} {
		ok, _, known := seedCompose(r).SignInWorks(context.Background())
		if ok {
			t.Errorf("%s: reported as a working sign-in", name)
		}
		if known {
			t.Errorf("%s: reported as a definite answer", name)
		}
	}
}
