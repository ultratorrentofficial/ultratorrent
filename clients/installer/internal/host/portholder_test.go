package host

import (
	"context"
	"errors"
	"strings"
	"testing"
)

var errFakeDocker = errors.New("docker unavailable")

// A busy port is not automatically a conflict. When this installation's own
// containers hold it, the deployment replaces them and the port is released as
// it goes — so refusing to proceed blocks the command that fixes a half-failed
// stack. When ANYTHING ELSE holds it, refusing is still correct.

type psRunner struct {
	out string
	err error
}

func (f *psRunner) Run(_ context.Context, _ string, _ ...string) (string, error) {
	return f.out, f.err
}

const psOutput = "ultratorrent\t0.0.0.0:8090->8080/tcp, [::]:8090->8080/tcp\n" +
	"media-stack\t\n" +
	"someone-else\t0.0.0.0:9000->9000/tcp\n"

func holderFor(t *testing.T, out string, err error) func(context.Context, int) string {
	t.Helper()
	return dockerPortHolder(&psRunner{out: out, err: err})
}

func TestThePublishedSideOfThePortMappingIsWhatMatches(t *testing.T) {
	h := holderFor(t, psOutput, nil)
	if got := h(context.Background(), 8090); got != "ultratorrent" {
		t.Errorf("published port 8090: got %q, want ultratorrent", got)
	}
	// 8080 appears only as the CONTAINER side of that mapping. Matching it
	// would report a port as taken that nothing is publishing.
	if got := h(context.Background(), 8080); got != "" {
		t.Errorf("container-side port 8080 matched %q; nothing publishes it", got)
	}
}

func TestAnUnrelatedProjectIsNotMistakenForUs(t *testing.T) {
	d := &Detector{
		LookupPort:  func(int) bool { return false }, // busy
		PortHolder:  holderFor(t, psOutput, nil),
		ProjectName: "ultratorrent",
	}
	got := d.PortHolder(context.Background(), 9000)
	if got == "ultratorrent" {
		t.Fatalf("someone-else's port reported as ours")
	}
	if got != "someone-else" {
		t.Errorf("holder of 9000: got %q, want someone-else", got)
	}
}

// Docker being absent or wedged must read as "not ours" — a wrong "ours" would
// take a port from a service already running on it.
func TestAnUnanswerableLookupIsNotTreatedAsOurs(t *testing.T) {
	h := holderFor(t, "", errFakeDocker)
	if got := h(context.Background(), 8090); got != "" {
		t.Errorf("a failed docker ps answered %q; must answer \"\"", got)
	}
}

func TestOurOwnPortPassesTheCheckAndSomeoneElsesDoesNot(t *testing.T) {
	newReport := func(port int, holder string) *Report {
		d := &Detector{
			Runner:       &psRunner{err: errFakeDocker},
			ReadFile:     func(string) ([]byte, error) { return nil, errFakeDocker },
			LookupPort:   func(int) bool { return false },
			DialRegistry: func(context.Context) bool { return true },
			Statfs:       func(string) (int64, int64, error) { return 1 << 40, 1 << 41, nil },
			PortHolder:   func(context.Context, int) string { return holder },
			ProjectName:  "ultratorrent",
		}
		return d.Detect(context.Background(), "/opt/ultratorrent",
			[]PortStatus{{Port: port, Label: "UltraTorrent web UI"}})
	}

	ours := newReport(8090, "ultratorrent").String()
	if strings.Contains(ours, "Port 8090         already in use") {
		t.Errorf("our own running stack blocked the re-run:\n%s", ours)
	}
	if !strings.Contains(ours, "in use by this installation") {
		t.Errorf("did not explain who holds the port:\n%s", ours)
	}

	theirs := newReport(8090, "media-stack").String()
	if !strings.Contains(theirs, "already in use") {
		t.Errorf("an unrelated holder was waved through:\n%s", theirs)
	}
}
