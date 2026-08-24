package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ultratorrent/installer/internal/plan"
)

// A bind-backed volume whose device is missing does not fail at `compose
// config` and is not created on demand: the container fails to START. The
// directories are therefore tied to whether a service is deployed, never to
// whether the installer happens to write a file into them — which is the bug
// these cover. Enabling Prowlarr on an installation whose secrets are reused
// generates no new API key, so no config.xml is written, so nothing created
// the directory, and the deployment failed on a mount.

func planWith(engine plan.Engine, prowlarr bool) *plan.Plan {
	p := &plan.Plan{}
	p.Torrent.Engine = engine
	p.Companions.Prowlarr = prowlarr
	return p
}

func TestEveryBoundDirectoryIsListedForTheServicesDeployed(t *testing.T) {
	cases := []struct {
		name   string
		plan   *plan.Plan
		expect []string
	}{
		{"bundled engine only", planWith(plan.EngineQbittorrent, false), []string{EngineConfigDirName}},
		{"engine and prowlarr", planWith(plan.EngineQbittorrent, true), []string{EngineConfigDirName, ProwlarrConfigDirName}},
		{"prowlarr with no bundled engine", planWith(plan.EngineNone, true), []string{ProwlarrConfigDirName}},
		{"neither", planWith(plan.EngineNone, false), nil},
	}
	for _, c := range cases {
		got := BoundConfigDirs(c.plan)
		if strings.Join(got, ",") != strings.Join(c.expect, ",") {
			t.Errorf("%s: got %v, want %v", c.name, got, c.expect)
		}
	}
}

// The case that broke: Prowlarr on, no new secret, therefore no file — the
// directory must still appear.
func TestTheDirectoryIsCreatedEvenWhenNoFileIsWrittenIntoIt(t *testing.T) {
	dir := t.TempDir()
	w := &Writer{Dir: dir}
	p := planWith(plan.EngineNone, true)

	// Render writes nothing for Prowlarr without an API key — the reused-secrets
	// case exactly.
	for _, f := range Render(p, &plan.Secrets{}) {
		if strings.HasPrefix(f.Name, ProwlarrConfigDirName+"/") {
			t.Fatalf("this test assumes no Prowlarr file is rendered, but got %s", f.Name)
		}
	}

	if _, err := w.EnsureBoundConfigDirs(p); err != nil {
		t.Fatalf("creating bound dirs: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, ProwlarrConfigDirName))
	if err != nil {
		t.Fatalf("Prowlarr's bind directory was not created: %v", err)
	}
	if !info.IsDir() {
		t.Error("created something that is not a directory")
	}
	if mode := info.Mode().Perm(); mode != ModeDir {
		t.Errorf("mode %o, want %o — these hold API keys", mode, ModeDir)
	}
}

func TestAnExistingDirectoryIsLeftAlone(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, ProwlarrConfigDirName)
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(target, "config.xml")
	if err := os.WriteFile(keep, []byte("<config/>"), 0o600); err != nil {
		t.Fatal(err)
	}

	w := &Writer{Dir: dir}
	actions, err := w.EnsureBoundConfigDirs(planWith(plan.EngineNone, true))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(actions) != 0 {
		t.Errorf("reported work on a directory that already existed: %v", actions)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Errorf("existing contents were disturbed: %v", err)
	}
}

func TestADryRunCreatesNothing(t *testing.T) {
	dir := t.TempDir()
	w := &Writer{Dir: dir, DryRun: true}
	actions, err := w.EnsureBoundConfigDirs(planWith(plan.EngineQbittorrent, true))
	if err != nil {
		t.Fatal(err)
	}
	if len(actions) != 2 {
		t.Errorf("a dry run should still say what it would do; got %d actions", len(actions))
	}
	for _, name := range []string{EngineConfigDirName, ProwlarrConfigDirName} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Errorf("a dry run created %s", name)
		}
	}
}
