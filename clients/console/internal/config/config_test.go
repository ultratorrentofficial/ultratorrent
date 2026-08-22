package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadTreatsAnAbsentFileAsAFreshStart(t *testing.T) {
	t.Setenv("UTCONSOLE_CONFIG", filepath.Join(t.TempDir(), "nope", "config.json"))
	cfg, err := Load()
	if err != nil {
		// The first run has no config; failing here prints a stack trace at
		// someone who has done nothing wrong.
		t.Fatalf("a missing config must not be an error: %v", err)
	}
	if cfg.RefreshSeconds != DefaultRefreshSeconds {
		t.Errorf("want the default interval, got %d", cfg.RefreshSeconds)
	}
}

func TestSaveIsOwnerOnly(t *testing.T) {
	// A nested path, so Save has to CREATE the directory: the guarantee is
	// about the directory this code makes, not about one it was handed.
	path := filepath.Join(t.TempDir(), "utconsole", "config.json")
	t.Setenv("UTCONSOLE_CONFIG", path)

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	cfg.ServerURL = "https://example.invalid"
	cfg.RefreshToken = "secret-token"
	if err := cfg.Save(); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// The file holds a credential. 0600 is applied at create time rather than
	// by a later chmod, which would leave a window where it is world-readable.
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("config mode = %#o, want 0600", mode)
	}
	if dir, err := os.Stat(filepath.Dir(path)); err == nil {
		if mode := dir.Mode().Perm(); mode&0o077 != 0 {
			t.Errorf("config dir mode = %#o, want no group/other access", mode)
		}
	}
}

func TestSaveDoesNotLeaveATempFileBehind(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	t.Setenv("UTCONSOLE_CONFIG", path)

	cfg, _ := Load()
	cfg.ServerURL = "https://example.invalid"
	if err := cfg.Save(); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("a temp file survived the save: %s", e.Name())
		}
	}
}

func TestRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("UTCONSOLE_CONFIG", path)

	first, _ := Load()
	first.ServerURL = "https://example.invalid/"
	first.RefreshToken = "tok"
	first.Username = "operator"
	if err := first.Save(); err != nil {
		t.Fatal(err)
	}

	second, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	// The trailing slash is normalised on load so paths are not doubled up.
	if second.ServerURL != "https://example.invalid" {
		t.Errorf("server url = %q", second.ServerURL)
	}
	if second.RefreshToken != "tok" || second.Username != "operator" {
		t.Errorf("round trip lost data: %+v", second)
	}
}

func TestClearKeepsTheServerButDropsTheSecret(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("UTCONSOLE_CONFIG", path)

	cfg, _ := Load()
	cfg.ServerURL = "https://example.invalid"
	cfg.RefreshToken = "tok"
	cfg.Username = "operator"
	if err := cfg.Save(); err != nil {
		t.Fatal(err)
	}
	if err := cfg.Clear(); err != nil {
		t.Fatal(err)
	}

	after, _ := Load()
	if after.RefreshToken != "" {
		t.Error("logging out must drop the credential")
	}
	// Signing out should not mean retyping the server address: the credential
	// is the secret, the address is not.
	if after.ServerURL == "" || after.Username == "" {
		t.Error("logging out must not forget where the server is")
	}
}

func TestWarnFlagsALooseFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("UTCONSOLE_CONFIG", path)

	cfg, _ := Load()
	cfg.RefreshToken = "tok"
	if err := cfg.Save(); err != nil {
		t.Fatal(err)
	}
	if w := cfg.Warn(); w != "" {
		t.Errorf("a freshly saved config should not warn, got %q", w)
	}

	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	// Advisory rather than fatal: refusing to start over a umask would strand
	// someone on a machine that may well be single-user.
	if w := cfg.Warn(); w == "" {
		t.Error("a world-readable token file should be reported")
	}
}

func TestInvalidJSONNamesTheFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	t.Setenv("UTCONSOLE_CONFIG", path)
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Load()
	if err == nil {
		t.Fatal("expected an error")
	}
	// The operator has to know which file to fix.
	if !strings.Contains(err.Error(), path) {
		t.Errorf("the error should name the file, got %q", err)
	}
}
