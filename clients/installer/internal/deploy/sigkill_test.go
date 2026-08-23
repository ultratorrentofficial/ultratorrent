package deploy

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// A container killed with SIGKILL logs nothing on its way out, so the log tail
// this diagnosis is built around is empty exactly when exit 137 appears. These
// tests cover what is printed instead.
//
// The case is not hypothetical: a postgres container on the test host exited
// 137 mid-deploy and the evidence that would have explained it was destroyed
// before anyone read it. "exit code 137" alone sends an operator to logs that
// cannot hold the answer.

// errNoSuchObject stands in for a container Docker can no longer inspect.
var errNoSuchObject = errors.New("no such object")

// composeFor returns a Compose whose Runner answers ps, logs and inspect.
func composeFor(t *testing.T, psJSON, oom string) *Compose {
	t.Helper()
	return &Compose{
		RepoDir: "/repo", InstallDir: "/opt/ut", ProjectName: "ultratorrent",
		Run: func(_ context.Context, name string, _ []string, args ...string) (string, string, error) {
			joined := strings.Join(args, " ")
			switch {
			case strings.Contains(joined, "inspect"):
				if oom == "" {
					return "", "no such object", errNoSuchObject
				}
				return oom + "\n", "", nil
			case strings.Contains(joined, "ps"):
				return psJSON, "", nil
			case strings.Contains(joined, "logs"):
				return "", "", nil // SIGKILL leaves nothing behind
			}
			return "", "", nil
		},
	}
}

const killedPS = `{"Service":"postgres","Name":"ultratorrent-postgres-1","State":"exited","ExitCode":137}`

func TestAnOutOfMemoryKillIsNamedAsOne(t *testing.T) {
	d := composeFor(t, killedPS, "true").Diagnose(context.Background(), 20, nil)
	out := d.String()
	if !strings.Contains(out, "exit code 137") {
		t.Fatalf("exit code missing:\n%s", out)
	}
	if !strings.Contains(out, "ran out of memory") {
		t.Errorf("an OOM kill was not named as one:\n%s", out)
	}
	if !strings.Contains(out, "build the images elsewhere") {
		t.Errorf("no action offered for an OOM kill:\n%s", out)
	}
}

func TestDockerSayingNotOOMIsNotReportedAsOOM(t *testing.T) {
	d := composeFor(t, killedPS, "false").Diagnose(context.Background(), 20, nil)
	out := d.String()
	if strings.Contains(out, "ran out of memory") {
		t.Errorf("claimed an OOM kill Docker denies:\n%s", out)
	}
	if !strings.Contains(out, "SIGKILL") {
		t.Errorf("the kill itself went unmentioned:\n%s", out)
	}
}

// The distinction that matters: not knowing must never print as fact.
func TestAnUnanswerableKillSaysSoAndPointsAtTheHost(t *testing.T) {
	d := composeFor(t, killedPS, "").Diagnose(context.Background(), 20, nil)
	out := d.String()
	if strings.Contains(out, "ran out of memory") || strings.Contains(out, "does not record") {
		t.Errorf("guessed a cause it could not know:\n%s", out)
	}
	if !strings.Contains(out, "dmesg") {
		t.Errorf("did not send the operator where the answer actually is:\n%s", out)
	}
	if _, known := d.OOM["postgres"]; known {
		t.Errorf("an unanswerable inspect was recorded as an answer")
	}
}

// A normal failure must not grow a SIGKILL note.
func TestAnOrdinaryFailureGetsNoKillNote(t *testing.T) {
	ps := `{"Service":"backend","Name":"ultratorrent-backend-1","State":"exited","ExitCode":1}`
	out := composeFor(t, ps, "false").Diagnose(context.Background(), 20, nil).String()
	if strings.Contains(out, "SIGKILL") {
		t.Errorf("exit 1 was described as a kill:\n%s", out)
	}
}
