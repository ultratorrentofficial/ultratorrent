import * as path from 'node:path';
import type { NormalizedTorrent } from '@ultratorrent/shared';

/**
 * Which torrents were seeding the files a rename just moved.
 *
 * When a library lives inside the download tree — which is the ordinary setup
 * here, and universal on the live hosts — a rename does not copy anything. It
 * MOVES the exact bytes a torrent is seeding. The engine is never told, so it
 * finds its files missing, rechecks to 0%, and downloads the whole thing again
 * next to the copy you just organised.
 *
 * Attribution is deliberately narrow, because the action it feeds is
 * irreversible:
 *
 *  - **`contentPath` only, never `savePath`.** `savePath` is the directory a
 *    torrent was saved INTO, and every film in a library shares it. Matching on
 *    it would name every torrent in `/downloads/Movies/HD Movies` as the owner
 *    of a single renamed file — hundreds of wrong removals from one rename.
 *  - **A torrent whose `contentPath` is empty is skipped.** rTorrent has no
 *    equivalent field. Unattributable is not the same as unowned, so it is left
 *    alone rather than guessed at.
 *  - **Containment is checked on path segments**, so `/downloads/Movie (2026)`
 *    does not claim `/downloads/Movie (2026) Extras/file.mkv`.
 */

/**
 * What to do about a torrent whose files a rename just moved.
 *
 *  - `remove` — drop the torrent entry. The default, because the alternative is
 *    not "nothing happens": the torrent errors, and on its next recheck it
 *    downloads the whole release again beside the copy just organised.
 *  - `report` — find them and say so, change nothing. For an operator who wants
 *    to decide each one.
 *  - `ignore` — do not even look.
 *
 * `remove` still requires the library to have opted into organising. Where it
 * has not, this degrades to `report` rather than acting: reporting is
 * non-destructive, so the orphan is surfaced instead of accumulating silently.
 */
export type SeedingTorrentAction = 'remove' | 'report' | 'ignore';

export interface SeedingTorrentPolicy {
  action: SeedingTorrentAction;
}

export const SEEDING_TORRENT_ACTIONS: SeedingTorrentAction[] = ['remove', 'report', 'ignore'];

export const DEFAULT_SEEDING_TORRENT_POLICY: SeedingTorrentPolicy = { action: 'remove' };

/** True when `child` is `parent` or sits beneath it, comparing whole segments. */
function isWithin(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export interface TorrentOwnership {
  hash: string;
  engineId: string;
  name: string;
  /** The moved files this torrent was seeding. */
  paths: string[];
}

/**
 * Map moved source paths to the torrents that were seeding them.
 *
 * `knownHashes` short-circuits the search for files whose provenance was
 * recorded at rename time (see `RenameRequest.sourceTorrentHash`) — an exact
 * answer beats a path comparison. Everything downloaded before that existed has
 * no recorded hash, which is why the path fallback has to be here at all.
 */
export function torrentsOwningPaths(
  torrents: NormalizedTorrent[],
  movedPaths: string[],
  knownHashes: string[] = [],
): TorrentOwnership[] {
  const owners = new Map<string, TorrentOwnership>();

  const add = (t: NormalizedTorrent, p?: string) => {
    const existing = owners.get(t.hash);
    if (existing) {
      if (p && !existing.paths.includes(p)) existing.paths.push(p);
      return;
    }
    owners.set(t.hash, {
      hash: t.hash,
      engineId: t.engineId,
      name: t.name,
      paths: p ? [p] : [],
    });
  };

  // Recorded provenance first — no inference involved.
  const known = new Set(knownHashes.filter(Boolean).map((h) => h.toLowerCase()));
  for (const t of torrents) {
    if (known.has(t.hash.toLowerCase())) add(t);
  }

  for (const p of movedPaths) {
    for (const t of torrents) {
      // Empty contentPath means the engine cannot say what this torrent owns.
      // Falling back to savePath here would match every torrent in the library.
      if (!t.contentPath) continue;
      if (isWithin(p, t.contentPath)) add(t, p);
    }
  }

  return [...owners.values()];
}
