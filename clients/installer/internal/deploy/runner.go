package deploy

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
)

// DefaultRunner runs a command and returns its streams separately.
//
// The separation is load-bearing, not tidiness. Every error path in this
// package reports firstLine(stderr), and Logs falls back to stderr when stdout
// is empty because Compose writes some log output there — merging the two
// would put progress noise into error messages and defeat that fallback.
//
// Lives in its own file so compose.go never imports os/exec: the argv this
// package builds is the part worth testing, and it stays testable without a
// Docker daemon.
func DefaultRunner() Runner {
	return func(ctx context.Context, name string, env []string, args ...string) (string, string, error) {
		cmd := exec.CommandContext(ctx, name, args...)
		if len(env) > 0 {
			cmd.Env = append(os.Environ(), env...)
		}

		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr

		// Compose reads none of the operator's environment beyond what it is
		// given, but it does read stdin on some paths; a nil Stdin makes it
		// /dev/null so a prompt can never hang an unattended install.
		cmd.Stdin = nil

		err := cmd.Run()

		// A cancelled or timed-out context reports as an exec error whose text
		// ("signal: killed") says nothing useful. Say which it was, because the
		// operator's next step differs: a timeout means look at the daemon, a
		// cancel means they pressed Ctrl-C.
		if ctxErr := ctx.Err(); ctxErr != nil {
			switch {
			case errors.Is(ctxErr, context.DeadlineExceeded):
				err = &TimeoutError{Cmd: name + " " + strings.Join(args, " "), Err: ctxErr}
			default:
				err = ctxErr
			}
		}
		return stdout.String(), stderr.String(), err
	}
}

// TimeoutError distinguishes "the command ran too long" from "the command
// failed", which the exit status alone cannot express.
type TimeoutError struct {
	Cmd string
	Err error
}

func (e *TimeoutError) Error() string {
	return "timed out running: " + e.Cmd
}

func (e *TimeoutError) Unwrap() error { return e.Err }
