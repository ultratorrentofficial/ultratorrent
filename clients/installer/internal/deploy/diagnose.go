package deploy

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// Status reports every container in the project.
//
// `ps --all` rather than the running ones: a container that exited is exactly
// what a failed deployment needs to show, and the default listing hides it.
func (c *Compose) Status(ctx context.Context) ([]ServiceStatus, error) {
	args, err := c.baseArgs()
	if err != nil {
		return nil, err
	}
	stdout, stderr, err := c.Run(ctx, "docker", append(args, "ps", "--all", "--format", "json")...)
	if err != nil {
		return nil, fmt.Errorf("listing containers: %s", firstLine(stderr))
	}
	return parseStatus(stdout)
}

// parseStatus reads Compose's JSON listing.
//
// Compose emits one JSON object PER LINE, not a JSON array — and has done both
// across versions, so both are accepted. Guessing wrong would leave the
// diagnosis silently empty at exactly the moment it is needed.
func parseStatus(stdout string) ([]ServiceStatus, error) {
	trimmed := strings.TrimSpace(stdout)
	if trimmed == "" {
		return nil, nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var all []ServiceStatus
		if err := json.Unmarshal([]byte(trimmed), &all); err != nil {
			return nil, fmt.Errorf("reading the container list: %w", err)
		}
		return all, nil
	}
	var all []ServiceStatus
	for _, line := range strings.Split(trimmed, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var one ServiceStatus
		if err := json.Unmarshal([]byte(line), &one); err != nil {
			// One unreadable line must not lose the rest of the diagnosis.
			continue
		}
		all = append(all, one)
	}
	return all, nil
}

// Logs returns the last lines from one service.
func (c *Compose) Logs(ctx context.Context, service string, lines int) (string, error) {
	args, err := c.baseArgs()
	if err != nil {
		return "", err
	}
	stdout, stderr, err := c.Run(ctx, "docker",
		append(args, "logs", "--no-color", "--tail", fmt.Sprintf("%d", lines), service)...)
	if err != nil {
		return "", fmt.Errorf("reading %s logs: %s", service, firstLine(stderr))
	}
	if strings.TrimSpace(stdout) == "" {
		return strings.TrimSpace(stderr), nil // Compose writes some logs to stderr
	}
	return stdout, nil
}

// Diagnosis explains a failed deployment.
type Diagnosis struct {
	Unhealthy []ServiceStatus
	// Logs holds the tail of each failing service, keyed by service name.
	Logs map[string]string
}

// Diagnose collects what an operator needs to act on a failure.
//
// The reason this exists: `up --wait` failing tells you only that something did
// not become healthy. The backend applies database migrations at startup, so the
// most likely real cause — a migration that failed — is visible ONLY in that
// container's log, and by the time an operator thinks to look the container may
// have been restarted by its policy and the lines scrolled past.
func (c *Compose) Diagnose(ctx context.Context, logLines int, redact func(string) string) *Diagnosis {
	statuses, err := c.Status(ctx)
	if err != nil {
		return &Diagnosis{}
	}
	d := &Diagnosis{Logs: map[string]string{}}
	for _, s := range statuses {
		if s.Healthy() {
			continue
		}
		d.Unhealthy = append(d.Unhealthy, s)
		logs, err := c.Logs(ctx, s.Service, logLines)
		if err != nil {
			continue
		}
		if redact != nil {
			// A backend that fails to connect prints its DATABASE_URL, password
			// included. This output is destined for a terminal an operator will
			// screenshot into an issue.
			logs = redact(logs)
		}
		d.Logs[s.Service] = strings.TrimSpace(logs)
	}
	return d
}

// Empty reports whether everything is healthy.
func (d *Diagnosis) Empty() bool { return d == nil || len(d.Unhealthy) == 0 }

// String renders the diagnosis for a terminal.
func (d *Diagnosis) String() string {
	if d.Empty() {
		return ""
	}
	var b strings.Builder
	b.WriteString("\nWhat went wrong\n")
	for _, s := range d.Unhealthy {
		state := s.State
		if s.Health != "" {
			state += ", " + s.Health
		}
		if s.State == "exited" {
			state += fmt.Sprintf(", exit code %d", s.Exit)
		}
		fmt.Fprintf(&b, "\n  %s — %s\n", s.Service, state)
		if logs := d.Logs[s.Service]; logs != "" {
			for _, line := range strings.Split(logs, "\n") {
				fmt.Fprintf(&b, "    | %s\n", line)
			}
		}
	}
	return b.String()
}
