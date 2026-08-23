package config

import (
	"fmt"
	"strings"

	"github.com/ultratorrent/installer/internal/plan"
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
