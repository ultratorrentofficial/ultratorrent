package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/ultratorrent/installer/internal/plan"
)

// emit used to close its output file with a deferred `f.Close()`, discarding the
// error. On a writable file that is where a delayed write actually fails — a full
// disk, a quota, a network mount that drops — so a truncated plan could land on
// disk while emit returned nil and printed "Plan written to …".
//
// Closing a file cannot be made to fail portably, so these cover the control flow
// that changed around it: the happy path still produces a complete file, and a
// path that cannot be opened is reported rather than swallowed.
func TestEmitWritesCompleteJSON(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "plan.json")

	if err := emit(&plan.Plan{}, false, out); err != nil {
		t.Fatalf("emit returned %v, want nil", err)
	}

	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("reading back the plan: %v", err)
	}
	if len(b) == 0 {
		t.Fatal("plan file is empty")
	}
	// Parseable, not merely non-empty: a close that dropped the tail would leave
	// bytes on disk that still fail here.
	var round map[string]any
	if err := json.Unmarshal(b, &round); err != nil {
		t.Fatalf("plan file is not valid JSON: %v", err)
	}
}

func TestEmitReportsAnUnwritableOutput(t *testing.T) {
	// A directory that does not exist: OpenFile fails, and emit must surface it.
	missing := filepath.Join(t.TempDir(), "no-such-dir", "plan.json")
	if err := emit(&plan.Plan{}, false, missing); err == nil {
		t.Fatal("emit returned nil for an unwritable output path")
	}
}

func TestEmitWithNoOutputWritesNoFile(t *testing.T) {
	dir := t.TempDir()
	if err := emit(&plan.Plan{}, false, ""); err != nil {
		t.Fatalf("emit returned %v, want nil", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("reading temp dir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("emit created %d file(s) with no output path", len(entries))
	}
}
