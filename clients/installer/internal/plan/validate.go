package plan

import (
	"fmt"
	"path/filepath"
	"strings"
)

// Problem is one finding against a plan.
//
// Errors and warnings are the same type with a severity, because the review
// screen shows them together and the distinction that matters is only whether
// the installer may proceed. Inventing two types would mean two renderers and
// two chances for them to disagree about wording.
type Problem struct {
	// Field is the plan path, e.g. "networking.frontendPort". Present so a
	// future non-interactive mode can point at the offending line of a config
	// file rather than making the user hunt.
	Field string
	// Message is written for the operator, not for a developer.
	Message string
	// Fatal means the installer must not proceed.
	Fatal bool
}

func (p Problem) String() string {
	if p.Field == "" {
		return p.Message
	}
	return p.Field + ": " + p.Message
}

// Validate checks everything that can be known without touching the host.
//
// Deliberately split from pre-flight: this function answers "is this plan
// internally coherent", which is pure and testable, while "is port 8080 free on
// this machine" belongs to host detection. Mixing them would make the plan model
// untestable without a Docker host.
//
// Returns every problem rather than the first, because a wizard that reports one
// mistake per run is a wizard the user runs five times.
func (p *Plan) Validate() []Problem {
	var problems []Problem
	add := func(field, message string, fatal bool) {
		problems = append(problems, Problem{Field: field, Message: message, Fatal: fatal})
	}

	if p.SchemaVersion != SchemaVersion {
		add("schemaVersion", fmt.Sprintf(
			"this installer understands plan schema %d, but the plan says %d",
			SchemaVersion, p.SchemaVersion), true)
	}

	// --- Install directory -------------------------------------------------
	switch {
	case p.InstallDirectory == "":
		add("installDirectory", "an installation directory is required", true)
	case !filepath.IsAbs(p.InstallDirectory):
		// A relative path would resolve against whatever directory the installer
		// happened to be run from, which is not something the operator chose.
		add("installDirectory", "must be an absolute path", true)
	case strings.Contains(p.InstallDirectory, ".."):
		add("installDirectory", "must not contain '..'", true)
	}

	// --- Networking --------------------------------------------------------
	validatePort(add, "networking.frontendPort", p.Networking.FrontendPort, true)
	if p.Networking.BehindReverseProxy && p.Networking.UseBundledProxy {
		add("networking", "cannot both sit behind an existing reverse proxy and "+
			"deploy the bundled one — the bundled proxy would bind ports 80 and 443 "+
			"that the existing proxy is already using", true)
	}
	if p.Networking.PublicURL != "" &&
		!strings.HasPrefix(p.Networking.PublicURL, "http://") &&
		!strings.HasPrefix(p.Networking.PublicURL, "https://") {
		add("networking.publicUrl", "must start with http:// or https://", true)
	}
	if p.Networking.PublicURL != "" &&
		strings.HasPrefix(p.Networking.PublicURL, "http://") &&
		!p.Networking.BehindReverseProxy && !isLoopbackURL(p.Networking.PublicURL) {
		// A warning, not a refusal: a trusted LAN over HTTP is a legitimate
		// choice, and blocking it would be the installer overruling the operator
		// about their own network.
		add("networking.publicUrl", "served over plain HTTP — fine on a trusted "+
			"private network, but put it behind HTTPS before exposing it to the internet", false)
	}

	// --- Ports must not collide with each other ----------------------------
	seen := map[int]string{}
	for _, binding := range p.PublishedPorts() {
		if binding.Port == 0 {
			continue // already reported by the per-field port check
		}
		if other, clash := seen[binding.Port]; clash {
			add("networking", fmt.Sprintf(
				"port %d is claimed by both %s and %s", binding.Port, other, binding.Label), true)
		}
		seen[binding.Port] = binding.Label
	}

	// --- Database / Redis --------------------------------------------------
	if p.Database.User == "" {
		add("database.user", "a database user is required", true)
	}
	if p.Database.Name == "" {
		add("database.name", "a database name is required", true)
	}
	if !isSafeIdentifier(p.Database.User) {
		add("database.user", "must contain only letters, digits and underscores", true)
	}
	if !isSafeIdentifier(p.Database.Name) {
		add("database.name", "must contain only letters, digits and underscores", true)
	}
	if p.Redis.Host == "" {
		add("redis.host", "a Redis host is required", true)
	}
	validatePort(add, "redis.port", p.Redis.Port, true)

	// --- Torrent engine ----------------------------------------------------
	switch p.Torrent.Engine {
	case EngineQbittorrent:
		if p.Torrent.PublishWebUI {
			validatePort(add, "torrentEngine.webUiPort", p.Torrent.WebUIPort, true)
		}
	case EngineRtorrent, EngineNone:
		// Nothing engine-specific to validate.
	case EngineExternal:
		if p.Torrent.ExternalURL == "" {
			add("torrentEngine.externalUrl",
				"an external engine needs the URL UltraTorrent should connect to", true)
		}
	case "":
		add("torrentEngine.engine", "a torrent engine choice is required "+
			"(qbittorrent, rtorrent, external or none)", true)
	default:
		add("torrentEngine.engine", fmt.Sprintf("unknown engine %q", p.Torrent.Engine), true)
	}
	if p.Torrent.Engine == EngineNone {
		add("torrentEngine.engine", "no torrent engine selected — UltraTorrent will "+
			"install and run, but cannot transfer anything until one is added", false)
	}

	// --- Storage -----------------------------------------------------------
	switch p.Storage.Mode {
	case StorageVolume:
		if p.Storage.MediaRoot != "" {
			add("storage.mediaRoot",
				"a media root is set but the storage mode is a Docker volume; "+
					"the path would be ignored", true)
		}
	case StorageBind:
		switch {
		case p.Storage.MediaRoot == "":
			add("storage.mediaRoot", "a host path is required for bind storage", true)
		case !filepath.IsAbs(p.Storage.MediaRoot):
			add("storage.mediaRoot", "must be an absolute path", true)
		case strings.Contains(p.Storage.MediaRoot, ".."):
			add("storage.mediaRoot", "must not contain '..'", true)
		}
		if p.Storage.MediaRoot != "" && p.InstallDirectory != "" &&
			withinPath(p.InstallDirectory, p.Storage.MediaRoot) {
			// Application configuration and media on the same tree means a
			// reinstall, a permissions change or a cleanup reaches both.
			add("storage.mediaRoot", "sits inside the installation directory — keep "+
				"media separate from application configuration so one cannot damage the other", false)
		}
	case "":
		add("storage.mode", "a storage mode is required (volume or bind)", true)
	default:
		add("storage.mode", fmt.Sprintf("unknown storage mode %q", p.Storage.Mode), true)
	}

	for i, lib := range p.Storage.Libraries {
		field := fmt.Sprintf("storage.libraries[%d]", i)
		if lib.Name == "" {
			add(field+".name", "a library name is required", true)
		}
		if lib.Kind == "" {
			add(field+".kind", "a library kind is required", true)
		}
		if lib.Path == "" {
			add(field+".path", "a library path is required", true)
		} else if !strings.HasPrefix(lib.Path, "/downloads") {
			// Everything the containers can see lives under /downloads; a path
			// outside it exists in no container and the library would be empty.
			add(field+".path", "must be under /downloads — that is the only tree "+
				"the containers share", true)
		}
	}

	// --- Media Intake ------------------------------------------------------
	if p.Intake.Enabled {
		if p.Intake.StagingPath == "" {
			add("mediaIntake.stagingPath", "a staging path is required when Managed Intake is on", true)
		} else if !strings.HasPrefix(p.Intake.StagingPath, "/downloads") {
			add("mediaIntake.stagingPath", "must be under /downloads", true)
		}
		if p.Intake.ProfileName == "" {
			add("mediaIntake.profileName", "a storage profile name is required", true)
		}
		for i, lib := range p.Storage.Libraries {
			if lib.Path != "" && p.Intake.StagingPath != "" && lib.Path == p.Intake.StagingPath {
				add(fmt.Sprintf("storage.libraries[%d].path", i),
					"is the same as the intake staging path — imports would move files "+
						"into the directory they are staged in", true)
			}
		}
	}

	// --- Companions --------------------------------------------------------
	if p.Companions.Prowlarr && p.Companions.PublishProwlarrUI {
		validatePort(add, "companions.prowlarrPort", p.Companions.ProwlarrPort, true)
	}
	if p.Companions.FlareSolverr && !p.Companions.Prowlarr {
		// FlareSolverr solves challenges *for Prowlarr*; alone it is a container
		// nothing talks to.
		add("companions.flaresolverr", "FlareSolverr is only used by Prowlarr, "+
			"which is not enabled — it would run with nothing to serve", true)
	}

	// --- Administrator -----------------------------------------------------
	if p.Admin.Username == "" {
		add("administrator.username", "an administrator username is required", true)
	}
	if p.Admin.Email == "" {
		add("administrator.email", "an administrator email is required", true)
	} else if !strings.Contains(p.Admin.Email, "@") {
		add("administrator.email", "does not look like an email address", true)
	}

	// --- Secrets, when already materialised ---------------------------------
	if p.Secrets != nil {
		for _, msg := range p.Secrets.Validate() {
			add("security", msg, true)
		}
	}

	return problems
}

// Fatal reports whether any problem blocks the installation.
func Fatal(problems []Problem) bool {
	for _, p := range problems {
		if p.Fatal {
			return true
		}
	}
	return false
}

// Errors and Warnings split a problem list for display.
func Errors(problems []Problem) []Problem   { return filter(problems, true) }
func Warnings(problems []Problem) []Problem { return filter(problems, false) }

func filter(problems []Problem, fatal bool) []Problem {
	out := make([]Problem, 0, len(problems))
	for _, p := range problems {
		if p.Fatal == fatal {
			out = append(out, p)
		}
	}
	return out
}

func validatePort(add func(string, string, bool), field string, port int, fatal bool) {
	switch {
	case port == 0:
		add(field, "a port is required", fatal)
	case port < 1 || port > 65535:
		add(field, fmt.Sprintf("%d is not a valid port (1–65535)", port), fatal)
	case port < 1024:
		// Not refused: 80 and 443 are exactly where a proxy belongs. Worth
		// saying because binding one needs privilege the daemon may not have.
		add(field, fmt.Sprintf("port %d is privileged; binding it requires root "+
			"or an explicit capability", port), false)
	}
}

// isSafeIdentifier allows only what a Postgres identifier can safely hold here.
//
// The user and database name are interpolated into DATABASE_URL by Compose, so
// anything outside this set is both a URL hazard and a quoting hazard.
func isSafeIdentifier(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_':
		default:
			return false
		}
	}
	return true
}

// withinPath reports whether child is inside parent.
//
// Compares cleaned paths with a separator appended, so `/opt/ultratorrent-data`
// is not treated as living inside `/opt/ultratorrent`.
func withinPath(parent, child string) bool {
	p := filepath.Clean(parent) + string(filepath.Separator)
	c := filepath.Clean(child) + string(filepath.Separator)
	return strings.HasPrefix(c, p)
}

func isLoopbackURL(u string) bool {
	return strings.Contains(u, "://localhost") ||
		strings.Contains(u, "://127.0.0.1") ||
		strings.Contains(u, "://[::1]")
}
