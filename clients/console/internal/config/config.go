// Package config stores what the console needs between runs.
//
// Exactly two things: which server to talk to, and the refresh token that
// proves who is talking. Nothing else is persisted — no cached snapshot, no
// remembered layout, no copy of anything the server owns. A console that
// accumulated local state would start disagreeing with the platform it exists
// to report on.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Config is the on-disk shape.
type Config struct {
	// ServerURL is the application root, e.g. https://ut.example.com.
	ServerURL string `json:"serverUrl"`
	// RefreshToken is the only secret here, and it rotates on every use.
	//
	// Stored in a 0600 file rather than an OS keyring: the machines this runs
	// on are headless servers where no keyring daemon exists, and a keyring
	// that silently falls back to a file is worse than a file that says so.
	// The access token is deliberately NOT stored — it lives in memory for
	// fifteen minutes and is cheap to re-obtain.
	RefreshToken string `json:"refreshToken,omitempty"`
	// Username is remembered for the login prompt only. Not a credential.
	Username string `json:"username,omitempty"`
	// RefreshSeconds is how often the TUI re-polls. Clamped against the
	// server's own advertised minimum at runtime, never below it.
	RefreshSeconds int `json:"refreshSeconds,omitempty"`
	// Locale selects the embedded catalog: en-US or es-PR.
	Locale string `json:"locale,omitempty"`

	path string
}

// DefaultRefreshSeconds is a deliberately unhurried default.
//
// The server advertises a 2s floor, but a console is read by a person, and a
// panel that rewrites itself twice a second is harder to read, not more
// informative. Five seconds is fast enough to watch a download move.
const DefaultRefreshSeconds = 5

// Path returns the config file location, honouring XDG on Unix.
func Path() (string, error) {
	if override := os.Getenv("UTCONSOLE_CONFIG"); override != "" {
		return override, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		home, herr := os.UserHomeDir()
		if herr != nil {
			return "", fmt.Errorf("cannot locate a config directory: %w", err)
		}
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "utconsole", "config.json"), nil
}

// Load reads the config, returning an empty one when the file is absent.
//
// Absence is not an error: the first run has no config, and treating that as a
// failure would mean printing a stack trace at someone who has done nothing
// wrong.
func Load() (*Config, error) {
	path, err := Path()
	if err != nil {
		return nil, err
	}
	cfg := &Config{path: path, RefreshSeconds: DefaultRefreshSeconds}

	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	if err := json.Unmarshal(raw, cfg); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	cfg.path = path
	if cfg.RefreshSeconds <= 0 {
		cfg.RefreshSeconds = DefaultRefreshSeconds
	}
	cfg.ServerURL = strings.TrimRight(cfg.ServerURL, "/")
	return cfg, nil
}

// Save writes the config with owner-only permissions.
//
// Written to a temporary file and renamed, so an interrupted write cannot leave
// a truncated config that locks the operator out of their own console. The
// 0600 is applied at create time rather than after: a chmod after the write
// leaves a window in which the token is world-readable.
func (c *Config) Save() error {
	if c.path == "" {
		path, err := Path()
		if err != nil {
			return err
		}
		c.path = path
	}
	if err := os.MkdirAll(filepath.Dir(c.path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, c.path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// Clear forgets the session but keeps the server and preferences.
//
// Logging out should not mean retyping the server URL: the credential is the
// secret, the address is not.
func (c *Config) Clear() error {
	c.RefreshToken = ""
	return c.Save()
}

// Location reports where this config lives, for `--help` and error messages.
func (c *Config) Location() string { return c.path }

// Warn describes any permission problem worth telling the operator about.
//
// Returns "" when the file is fine or absent. This is advisory rather than
// enforced: refusing to start because a file is group-readable would strand
// someone whose umask is not their fault, on a machine that may well be
// single-user. Saying so once is the proportionate response.
func (c *Config) Warn() string {
	if runtime.GOOS == "windows" || c.path == "" {
		return ""
	}
	info, err := os.Stat(c.path)
	if err != nil {
		return ""
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		return fmt.Sprintf(
			"%s is mode %#o — it holds a refresh token and should be 0600", c.path, mode,
		)
	}
	return ""
}
