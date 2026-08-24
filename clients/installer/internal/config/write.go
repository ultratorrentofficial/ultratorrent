package config

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ultratorrent/installer/internal/companion"
	"github.com/ultratorrent/installer/internal/engine"
	"github.com/ultratorrent/installer/internal/plan"
	"github.com/ultratorrent/installer/internal/proxy"
)

// File is one rendered file, with the mode it must be created with.
type File struct {
	Name string
	// Mode matters most for `.env`. It is applied AT CREATE TIME rather than by
	// a chmod afterwards: a chmod leaves a window, however brief, in which a
	// file full of signing keys is world-readable.
	Mode    fs.FileMode
	Content string
	// Secret marks a file whose contents must never be echoed, logged or
	// included in diagnostics.
	Secret bool
	// Once marks a file the installer creates but never replaces.
	//
	// For configuration the APPLICATION owns after first start: qBittorrent
	// rewrites its own settings file as the operator changes things in the UI, so
	// regenerating it on a later run would silently discard all of that. The
	// installer seeds it and then keeps its hands off.
	Once bool
}

// Modes for what the installer writes.
const (
	// ModeSecret is owner read/write only. `.env` holds every secret the
	// deployment has.
	ModeSecret fs.FileMode = 0o600
	// ModePublic is world-readable. The override and state files describe
	// topology, not credentials.
	ModePublic fs.FileMode = 0o644
	// ModeDir keeps the installation directory owner-only. It contains `.env`,
	// and a directory anyone can traverse makes a 0600 file inside it easier to
	// find than it should be.
	ModeDir fs.FileMode = 0o700
)

// Names of the files the installer owns.
const (
	EnvFileName      = ".env"
	OverrideFileName = "docker-compose.override.yml"
	// EngineConfigDirName is bound into the bundled engine as its config volume,
	// so the installer can seed settings before the engine's first start and the
	// operator can read them afterwards.
	EngineConfigDirName = "qbittorrent"
	// EngineConfigFileName is relative to the installation directory.
	EngineConfigFileName = EngineConfigDirName + "/" + engine.ConfigPath
	// EngineCredentialsFileName records the engine's Web UI password in plain
	// text, because the config file stores only a one-way verifier: without this
	// the operator could never sign in, and could never give UltraTorrent's
	// backend the credentials it needs to drive the engine.
	EngineCredentialsFileName = "engine-credentials.txt"
	// ProwlarrConfigDirName is bound in as Prowlarr's config volume, so its API
	// key can be seeded before first start.
	ProwlarrConfigDirName = "prowlarr"
	// ProwlarrConfigFileName is relative to the installation directory.
	ProwlarrConfigFileName = ProwlarrConfigDirName + "/" + companion.ProwlarrConfigPath
)

// QbittorrentContainerPort is the port the Compose file maps the bundled engine's
// Web UI to inside the container. It is fixed there (`${QBITTORRENT_PORT}:8080`),
// which is why a published port other than this one needs qBittorrent's Host
// header check relaxed — see engine.Settings.RelaxHostHeaderValidation.
const QbittorrentContainerPort = 8080

// ProwlarrContainerPort is the port Prowlarr listens on inside its container.
const ProwlarrContainerPort = 9696

// Render produces every file an installation needs.
//
// Pure: no filesystem, no clock beyond the plan's own timestamp. What a
// deployment gets is therefore a string comparison in a test rather than
// something only observable by installing it.
//
// The override is omitted entirely when the plan needs no specialisation.
// Compose merges any override it finds, so an empty-but-present file is not the
// same as no file — and a deployment that needs nothing should have nothing.
func Render(p *plan.Plan, s *plan.Secrets) []File {
	files := []File{{
		Name:    EnvFileName,
		Mode:    ModeSecret,
		Content: RenderEnv(p, s),
		Secret:  true,
	}}
	if override := RenderOverride(p); override != "" {
		files = append(files, File{
			Name:    OverrideFileName,
			Mode:    ModePublic,
			Content: override,
		})
	}
	if f, ok := renderEngineConfig(p, s); ok {
		files = append(files, f, renderEngineCredentials(p, s))
	}
	if f, ok := renderProwlarrConfig(p, s); ok {
		files = append(files, f)
	}
	if p.Networking.UseBundledProxy {
		files = append(files, File{
			Name: proxy.CaddyfileName,
			Mode: ModePublic,
			Content: proxy.RenderCaddyfile(proxy.Settings{
				PublicURL: p.Networking.PublicURL,
			}),
		})
	}
	return files
}

// renderProwlarrConfig seeds Prowlarr's API key before its first start.
//
// Without it the key is generated inside the container and the integration can
// only be wired by asking the operator to copy it out of a web UI. With it, the
// Prowlarr link and the FlareSolverr indexer proxy are both reachable through
// Prowlarr's own API.
//
// Write-once: Prowlarr rewrites this file itself.
func renderProwlarrConfig(p *plan.Plan, s *plan.Secrets) (File, bool) {
	if !p.Companions.Prowlarr || s == nil || s.ProwlarrAPIKey == "" {
		return File{}, false
	}
	return File{
		Name: ProwlarrConfigFileName,
		// It holds an API key that grants full control of the indexer manager.
		Mode:   ModeSecret,
		Secret: true,
		Once:   true,
		Content: companion.RenderProwlarrConfig(companion.ProwlarrSettings{
			APIKey:    s.ProwlarrAPIKey,
			Port:      ProwlarrContainerPort,
			PublishUI: p.Companions.PublishProwlarrUI,
		}),
	}, true
}

// renderEngineCredentials records the engine's password where the operator can
// find it.
//
// The config file holds a PBKDF2 verifier, which is one-way by design, so the
// password would otherwise exist only in the memory of the process that
// generated it. Written 0600 alongside `.env`, which already holds every other
// secret this deployment has — and write-once, so it can never drift from the
// verifier that was actually seeded.
func renderEngineCredentials(p *plan.Plan, s *plan.Secrets) File {
	return File{
		Name:   EngineCredentialsFileName,
		Mode:   ModeSecret,
		Secret: true,
		Once:   true,
		Content: fmt.Sprintf(`%s#
# Sign-in for the bundled qBittorrent Web UI, and the credentials to give
# UltraTorrent under Settings -> Integrations so it can drive the engine.
#
# The engine stores only a one-way hash of this password, so this file is the
# only copy. Change the password in qBittorrent's own UI once you are in, and
# delete this file afterwards.

username=%s
password=%s
`, Header(p.InstallerVersion, p.CreatedAt.Format("2006-01-02 15:04:05 MST")),
			p.Admin.Username, s.EnginePassword),
	}
}

// renderEngineConfig seeds the bundled engine so it never issues the temporary
// password it otherwise prints to its log.
//
// Write-once: qBittorrent rewrites this file itself as the operator changes
// settings, so the installer creates it and never touches it again.
func renderEngineConfig(p *plan.Plan, s *plan.Secrets) (File, bool) {
	if p.Torrent.Engine != plan.EngineQbittorrent || s == nil || s.EnginePassword == "" {
		return File{}, false
	}
	verifier, err := engine.NewVerifier(s.EnginePassword)
	if err != nil {
		// Only a failure of crypto/rand, which is not a condition to paper over.
		panic("config: generating the engine verifier: " + err.Error())
	}
	return File{
		Name: EngineConfigFileName,
		// It holds a password verifier: readable by its owner only.
		Mode: ModeSecret,
		Content: engine.RenderConfigWithPassword(engine.Settings{
			Username: p.Admin.Username,
			Port:     QbittorrentContainerPort,
			SavePath: "/downloads/",
			TempPath: "/downloads/incomplete/",
			// qBittorrent rejects any request whose Host header names a port
			// other than its own, so publishing on a host port that differs from
			// the container port makes the UI answer 401 to a browser — the
			// shipped 8081:8080 default does exactly this.
			RelaxHostHeaderValidation: p.Torrent.PublishWebUI &&
				p.Torrent.WebUIPort != QbittorrentContainerPort,
		}, verifier),
		Secret: true,
		Once:   true,
	}, true
}

// Writer writes rendered files safely.
type Writer struct {
	// Dir is the installation directory.
	Dir string
	// DryRun makes every operation report what it would do and change nothing.
	// The same code path runs either way, so a dry run cannot describe something
	// the real run would not do.
	DryRun bool
	// Now supplies backup timestamps; injected for deterministic tests.
	Now func() time.Time
}

// Action is one thing the writer did, or would do.
type Action struct {
	Path string
	// Kind is create | replace | unchanged | backup.
	Kind string
	// Detail is human-facing, and never contains file contents — a "replace"
	// line for `.env` must not print what changed.
	Detail string
}

func (a Action) String() string {
	if a.Detail == "" {
		return fmt.Sprintf("%-9s %s", a.Kind, a.Path)
	}
	return fmt.Sprintf("%-9s %s (%s)", a.Kind, a.Path, a.Detail)
}

// EnsureDir creates the installation directory.
func (w *Writer) EnsureDir() (Action, error) {
	if _, err := os.Stat(w.Dir); err == nil {
		return Action{Path: w.Dir, Kind: "unchanged", Detail: "directory exists"}, nil
	}
	if w.DryRun {
		return Action{Path: w.Dir, Kind: "create", Detail: "directory"}, nil
	}
	if err := os.MkdirAll(w.Dir, ModeDir); err != nil {
		return Action{}, fmt.Errorf("creating %s: %w", w.Dir, err)
	}
	return Action{Path: w.Dir, Kind: "create", Detail: "directory"}, nil
}

// BoundConfigDirs names the directories the generated override binds as
// container config volumes.
//
// They must exist before `compose up`, and existing is ALL that is required:
// a bind-backed volume whose device is missing does not fail at `compose
// config` and is not created on demand — the container fails to start with an
// error naming an internal Docker path and no hint that a host directory is
// missing.
//
// Listing them separately from the files written into them is the point. The
// installer seeds each of these directories with a config file, but only when
// it has something new to seed: qBittorrent's is written once, from a freshly
// generated password, and Prowlarr's once from a freshly generated API key.
// Neither is regenerated for an installation whose secrets are being reused,
// which is correct — rewriting them would discard settings the application has
// since changed. The consequence was that turning a companion ON for an
// existing installation wrote no file, so nothing created its directory, and
// the deployment failed on a mount rather than on anything to do with the
// companion. Directories are cheap and idempotent; tie them to whether the
// service is deployed, never to whether a file happens to be written.
func BoundConfigDirs(p *plan.Plan) []string {
	var dirs []string
	if p.Torrent.Engine == plan.EngineQbittorrent {
		dirs = append(dirs, EngineConfigDirName)
	}
	if p.Companions.Prowlarr {
		dirs = append(dirs, ProwlarrConfigDirName)
	}
	return dirs
}

// EnsureBoundConfigDirs creates them, reporting what it did.
func (w *Writer) EnsureBoundConfigDirs(p *plan.Plan) ([]Action, error) {
	var actions []Action
	for _, name := range BoundConfigDirs(p) {
		path := filepath.Join(w.Dir, name)
		if _, err := os.Stat(path); err == nil {
			continue // Already there; its contents are not this function's business.
		}
		if w.DryRun {
			actions = append(actions, Action{Path: path, Kind: "create",
				Detail: "config directory bound into the container"})
			continue
		}
		// ModeDir, like every other directory the installer owns: these hold
		// API keys and password verifiers.
		if err := os.MkdirAll(path, ModeDir); err != nil {
			return actions, fmt.Errorf("creating %s: %w", path, err)
		}
		actions = append(actions, Action{Path: path, Kind: "create",
			Detail: "config directory bound into the container"})
	}
	return actions, nil
}

// Write writes one file, backing up any existing version first.
//
// The order is deliberate: back up, write to a temporary file with the final
// mode, then rename over the target. A rename is atomic on the same filesystem,
// so an interrupted write cannot leave a half-written `.env` — which would take
// the whole stack down on the next `compose up`, since Compose refuses to start
// without the secrets it expects.
func (w *Writer) Write(f File) ([]Action, error) {
	path := filepath.Join(w.Dir, f.Name)
	var actions []Action

	existing, err := os.ReadFile(path)
	if f.Once && err == nil {
		// Present already: this belongs to the application now.
		return []Action{{Path: path, Kind: "unchanged", Detail: "kept; the engine owns this file"}}, nil
	}
	switch {
	case err == nil && SameGeneratedContent(string(existing), f.Content):
		// Identical content is not a change. Saying "unchanged" rather than
		// rewriting keeps a re-run honest and avoids a pointless backup.
		return []Action{{Path: path, Kind: "unchanged"}}, nil

	case err == nil:
		backup, err := w.backupPath(path)
		if err != nil {
			return nil, err
		}
		if !w.DryRun {
			if err := os.WriteFile(backup, existing, f.Mode); err != nil {
				return nil, fmt.Errorf("backing up %s: %w", path, err)
			}
		}
		actions = append(actions, Action{Path: backup, Kind: "backup",
			Detail: "previous " + f.Name})
		actions = append(actions, Action{Path: path, Kind: "replace"})

	case os.IsNotExist(err):
		actions = append(actions, Action{Path: path, Kind: "create"})

	default:
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}

	if w.DryRun {
		return actions, nil
	}

	// A file may sit in a subdirectory of the installation directory (an engine's
	// config volume, for instance), which will not exist on a first run.
	if parent := filepath.Dir(path); parent != w.Dir {
		if err := os.MkdirAll(parent, ModeDir); err != nil {
			return nil, fmt.Errorf("creating %s: %w", parent, err)
		}
	}

	tmp := path + ".tmp"
	// O_EXCL so a stale temp file from a crashed run is noticed rather than
	// silently reused, and the mode is set here rather than by a later chmod.
	fh, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, f.Mode)
	if err != nil {
		return nil, fmt.Errorf("creating %s: %w", tmp, err)
	}
	if _, err := fh.WriteString(f.Content); err != nil {
		fh.Close()
		os.Remove(tmp)
		return nil, fmt.Errorf("writing %s: %w", tmp, err)
	}
	if err := fh.Close(); err != nil {
		os.Remove(tmp)
		return nil, err
	}
	// A umask can loosen the mode at create time on some systems; assert it.
	if err := os.Chmod(tmp, f.Mode); err != nil {
		os.Remove(tmp)
		return nil, err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return nil, fmt.Errorf("replacing %s: %w", path, err)
	}
	return actions, nil
}

// Remove deletes a file the installer owns, backing it up first.
//
// Used when a plan stops needing an override it previously generated — leaving a
// stale override behind would keep applying settings the operator has removed.
func (w *Writer) Remove(name string) ([]Action, error) {
	path := filepath.Join(w.Dir, name)
	existing, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	backup, err := w.backupPath(path)
	if err != nil {
		return nil, err
	}
	if !w.DryRun {
		if err := os.WriteFile(backup, existing, ModePublic); err != nil {
			return nil, err
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	}
	return []Action{
		{Path: backup, Kind: "backup", Detail: "previous " + name},
		{Path: path, Kind: "remove", Detail: "no longer needed by this plan"},
	}, nil
}

// backupPath builds a timestamped sibling that does not already exist.
func (w *Writer) backupPath(path string) (string, error) {
	now := time.Now
	if w.Now != nil {
		now = w.Now
	}
	stamp := now().Format("20060102-150405")
	candidate := fmt.Sprintf("%s.backup-%s", path, stamp)
	// Two reconfigures in the same second must not silently overwrite each
	// other's backup — the older one is the one worth keeping.
	for i := 1; ; i++ {
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate, nil
		} else if err != nil {
			return "", err
		}
		candidate = fmt.Sprintf("%s.backup-%s.%d", path, stamp, i)
		if i > 100 {
			return "", fmt.Errorf("could not find an unused backup name for %s", path)
		}
	}
}

// Redact removes secret values from text destined for a log or the screen.
//
// Belt and braces: the installer already avoids printing file contents, but a
// future error message that quotes a line of `.env` would otherwise leak a
// signing key into a diagnostic bundle someone attaches to an issue.
func Redact(text string, secrets ...string) string {
	for _, secret := range secrets {
		if len(secret) < 8 {
			// Too short to redact safely — replacing it would mangle unrelated
			// text. A secret this short fails validation long before here.
			continue
		}
		text = strings.ReplaceAll(text, secret, "********")
	}
	return text
}

// StampPrefix begins the header line recording when a file was generated.
const StampPrefix = "# Generated: "

// SameGeneratedContent reports whether two renderings are the same file, ignoring
// the timestamp in their header.
//
// The stamp moves on every run by construction, so comparing raw bytes would
// make every re-run look like a change: `.env` and the override would be backed
// up and rewritten each time, filling the installation directory with backups of
// nothing and — far worse — burying a genuine change in the noise, which is
// precisely when an operator needs to see one.
//
// When the content is otherwise unchanged the existing file is kept as it is,
// stamp included. That is the more truthful record anyway: the file really was
// generated then, and really has not changed since.
func SameGeneratedContent(a, b string) bool {
	return stripStamp(a) == stripStamp(b)
}

func stripStamp(content string) string {
	lines := strings.Split(content, "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, StampPrefix) {
			lines[i] = StampPrefix
			// Only the header carries one, so there is nothing to gain from
			// scanning the whole file — and a value further down that happened to
			// start with the same text must not be treated as a stamp.
			break
		}
	}
	return strings.Join(lines, "\n")
}
