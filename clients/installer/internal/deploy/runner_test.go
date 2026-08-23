package deploy

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// The streams must stay separate: every error path here reports
// firstLine(stderr), and Logs falls back to stderr when stdout is empty.
func TestDefaultRunnerKeepsStreamsSeparate(t *testing.T) {
	run := DefaultRunner()
	stdout, stderr, err := run(context.Background(), "sh", nil, "-c", "echo to-out; echo to-err >&2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(stdout, "to-out") || strings.Contains(stdout, "to-err") {
		t.Errorf("stdout = %q, want only the stdout line", stdout)
	}
	if !strings.Contains(stderr, "to-err") || strings.Contains(stderr, "to-out") {
		t.Errorf("stderr = %q, want only the stderr line", stderr)
	}
}

// A failing command must still yield its stderr — that is what the error
// messages in this package are built from.
func TestDefaultRunnerReturnsStderrOnFailure(t *testing.T) {
	run := DefaultRunner()
	_, stderr, err := run(context.Background(), "sh", nil, "-c", "echo why >&2; exit 3")
	if err == nil {
		t.Fatal("expected an error for exit 3")
	}
	if !strings.Contains(stderr, "why") {
		t.Errorf("stderr = %q, want the reason", stderr)
	}
}

// "signal: killed" tells an operator nothing. A timeout and a cancellation
// lead to different next steps, so they are reported differently.
func TestDefaultRunnerDistinguishesTimeoutFromCancel(t *testing.T) {
	run := DefaultRunner()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, _, err := run(ctx, "sleep", nil, "5")
	var te *TimeoutError
	if !errors.As(err, &te) {
		t.Fatalf("timeout: got %v, want a *TimeoutError", err)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("timeout error should unwrap to DeadlineExceeded, got %v", err)
	}

	ctx2, cancel2 := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel2() }()
	_, _, err = run(ctx2, "sleep", nil, "5")
	if !errors.Is(err, context.Canceled) {
		t.Errorf("cancel: got %v, want context.Canceled", err)
	}
}

// An unattended install must never block on a prompt.
func TestDefaultRunnerGivesNoStdin(t *testing.T) {
	run := DefaultRunner()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	stdout, _, err := run(ctx, "sh", nil, "-c", "cat; echo done")
	if err != nil {
		t.Fatalf("reading stdin should hit EOF immediately, got %v", err)
	}
	if !strings.Contains(stdout, "done") {
		t.Errorf("stdout = %q, want the command to have completed", stdout)
	}
}
