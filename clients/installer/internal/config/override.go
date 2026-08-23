package config

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/ultratorrent/installer/internal/plan"
	"github.com/ultratorrent/installer/internal/proxy"
)

// RenderOverride produces docker-compose.override.yml, or "" when the plan needs
// no specialisation at all.
//
// Returning "" matters: Compose merges any override it finds, so writing an
// empty-but-present file is not the same as writing none. A deployment that
// needs nothing should have nothing, so a later `docker compose config` shows
// exactly the canonical stack.
//
// Written as a template rather than through a YAML library on purpose. The file
// is small and fixed-shape, and the comments explaining WHY each stanza exists
// are the most valuable thing in it — a marshaller would strip them, leaving an
// operator to guess why their volume is defined twice.
func RenderOverride(p *plan.Plan) string {
	stanzas := make([]string, 0, 2)

	if body := renderServiceOverrides(p); body != "" {
		stanzas = append(stanzas, "services:\n"+body)
	}
	if body := renderVolumeOverride(p); body != "" {
		stanzas = append(stanzas, "volumes:\n"+body)
	}
	if len(stanzas) == 0 {
		return ""
	}

	var b strings.Builder
	b.WriteString(Header(p.InstallerVersion, p.CreatedAt.Format("2006-01-02 15:04:05 MST")))
	b.WriteString("#\n# Compose merges this over the repository's docker-compose.yml, which is\n")
	b.WriteString("# left untouched. Only what this installation needs to specialise is here.\n\n")
	b.WriteString(strings.Join(stanzas, "\n"))
	return b.String()
}

// renderServiceOverrides handles per-service changes.
func renderServiceOverrides(p *plan.Plan) string {
	var b strings.Builder

	if p.Networking.UseBundledProxy {
		/*
		 * The repository's deploy/Caddyfile is tracked and mounted read-only, and
		 * is hardcoded to :80 — so configuring the proxy at all means either
		 * editing a file that belongs to the project, or pointing the mount
		 * somewhere else. Editing it would fork the installation from upstream
		 * the first time that file changed, which is the same reason
		 * docker-compose.yml is never generated.
		 */
		fmt.Fprintf(&b, `  # Points the bundled proxy at the generated Caddyfile. The repository's
  # deploy/Caddyfile is tracked and read-only, and hardcoded to :80; editing it
  # would fork this installation from the project.
  proxy:
    volumes:
      - %s:/etc/caddy/Caddyfile:ro

`, yamlPath(filepath.Join(p.InstallDirectory, proxy.CaddyfileName)))
	}

	if !p.Companions.PublishProwlarrUI && p.Companions.Prowlarr {
		/*
		 * Prowlarr starts with NO authentication and there is no setting that is
		 * both safe and usable for a published UI — measured, not assumed. So the
		 * UI stays on the internal network unless the operator asks otherwise,
		 * where the API key is the only credential that matters.
		 *
		 * `!reset` rather than an empty list: a `ports:` list in an override is
		 * APPENDED to the base one, so writing `ports: []` would leave the
		 * original mapping in place and quietly do nothing.
		 */
		b.WriteString(`  # Keeps Prowlarr off the host network. It starts with no authentication,
  # and no Prowlarr setting both enforces auth and lets you create the first
  # account, so publishing it would expose an unauthenticated admin UI.
  prowlarr:
    ports: !reset []

`)
	}

	if p.Torrent.Engine == plan.EngineQbittorrent && !p.Torrent.PublishWebUI {
		b.WriteString(`  # Keeps the engine's Web UI off the host network. UltraTorrent drives the
  # engine over the internal network; the UI is only for direct inspection.
  qbittorrent:
    ports: !reset []

`)
	}

	if p.Torrent.PUID > 0 || p.Torrent.PGID > 0 {
		/*
		 * Ownership is a two-sided problem and setting only one side is the
		 * mistake worth preventing.
		 *
		 * PUID/PGID in .env reach the bundled ENGINE, so downloads land as the
		 * right user. But the BACKEND also writes into the same tree — imports,
		 * renames, NFO and artwork files — and it runs as its image's own user.
		 * Left alone it writes files the engine's user cannot manage, and the
		 * mismatch surfaces much later as a permission error during an import.
		 */
		fmt.Fprintf(&b, `  # The backend writes into the same tree as the engine (imports, renames,
  # artwork), so it must run as the same user or it leaves files the engine
  # cannot manage — which surfaces later as a permission error mid-import.
  backend:
    user: "%d:%d"

`, p.Torrent.PUID, p.Torrent.PGID)
	}
	return b.String()
}

// renderVolumeOverride points the shared `downloads` volume at a host path.
func renderVolumeOverride(p *plan.Plan) string {
	var b strings.Builder
	b.WriteString(renderEngineConfigVolume(p))
	b.WriteString(renderProwlarrConfigVolume(p))
	b.WriteString(renderDownloadsVolume(p))
	return b.String()
}

// renderProwlarrConfigVolume binds Prowlarr's config volume, for the same reason
// the engine's is bound: a named volume cannot be written to before a container
// mounts it, so the API key could not be seeded.
func renderProwlarrConfigVolume(p *plan.Plan) string {
	if !p.Companions.Prowlarr {
		return ""
	}
	return fmt.Sprintf(`  # Binds Prowlarr's config volume so its API key can be seeded before first
  # start. Without that the key is generated inside the container and the only
  # way to wire the integration is to copy it out of Prowlarr's web UI.
  prowlarr_config:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: %s

`, yamlPath(filepath.Join(p.InstallDirectory, ProwlarrConfigDirName)))
}

// renderEngineConfigVolume binds the bundled engine's config volume to a host
// directory inside the installation.
//
// Not cosmetic: it is what lets the installer SEED the engine's settings before
// its first start. A named volume cannot be written to until something mounts
// it, so with the default the only way to set a password is the one the Compose
// file documents today — read a temporary one out of the container's log.
// Binding it also leaves the file where an operator can read and edit it.
func renderEngineConfigVolume(p *plan.Plan) string {
	if p.Torrent.Engine != plan.EngineQbittorrent {
		return ""
	}
	return fmt.Sprintf(`  # Binds the engine's config volume into the installation directory, which is
  # what lets the installer seed a password before the engine first starts —
  # otherwise the only way to get one is to read the temporary password out of
  # the container log. It also leaves the settings where you can read them.
  qbittorrent_config:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: %s

`, yamlPath(filepath.Join(p.InstallDirectory, EngineConfigDirName)))
}

func renderDownloadsVolume(p *plan.Plan) string {
	if p.Storage.Mode != plan.StorageBind || p.Storage.MediaRoot == "" {
		return ""
	}
	/*
	 * The VOLUME is redefined, not each service's mount.
	 *
	 * backend, rtorrent and qbittorrent all mount `downloads:/downloads`.
	 * Redefining the volume moves all three together and cannot drift; rewriting
	 * three separate mounts would have to be repeated for every service added
	 * later, and the first one forgotten would silently write to a different
	 * place. The in-container path stays /downloads, so FILE_MANAGER_ROOTS and
	 * every engine savePath keep working untouched.
	 *
	 * `o: bind` with `type: none` is a bind mount wearing a named volume's
	 * clothes — the pattern already proven in this project's own deployments.
	 */
	return fmt.Sprintf(`  # Points the shared 'downloads' volume at a host directory.
  #
  # The volume is redefined rather than each service's mount: backend, rtorrent
  # and qbittorrent all mount downloads:/downloads, so this moves all three at
  # once and they cannot drift apart. The path inside the containers stays
  # /downloads, so FILE_MANAGER_ROOTS and engine save paths are unaffected.
  #
  # Changing 'device' later does NOT move existing data, and does not take
  # effect until the volume is recreated.
  downloads:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: %s
`, yamlPath(p.Storage.MediaRoot))
}

// yamlPath quotes a path when YAML would otherwise misread it.
//
// A path is user input reaching a config file, so it is quoted rather than
// trusted. Single quotes with internal doubling is YAML's own escape, and it
// makes a path containing a colon, a hash or a leading indicator character
// unambiguous instead of silently parsing as something else.
func yamlPath(path string) string {
	if path == "" {
		return `''`
	}
	needsQuote := strings.ContainsAny(path, `:#{}[],&*?|<>=!%@\"'`+"\t ")
	if !needsQuote {
		// Still safe unquoted only when it starts with a plain character.
		if c := path[0]; c == '/' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') {
			return path
		}
	}
	return "'" + strings.ReplaceAll(path, "'", "''") + "'"
}
