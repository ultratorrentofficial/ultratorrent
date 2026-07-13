import * as path from 'node:path';
import { isSeasonContainer, showFolderRoot } from './media-renamer';
import { normalize } from '../rss/match-engine';

/**
 * Show-grouping for the TV media browser. Episodes are grouped into their parent
 * SHOW so the browser never lists individual episodes at the top level. The key
 * is the show FOLDER (climbing past `Season NN`/`Specials` containers), NOT
 * `MediaItem.title` — a folder-organised episode's title is usually the *episode*
 * name, so title-grouping fragments one show into one "show" per episode. Files
 * sitting directly at a library root (no show folder) fall back to their title.
 *
 * This mirrors `AcquisitionWatchlistService.librarySeries()` but is reusable and
 * carries the round-trippable `key` the browser needs to fetch a show's episodes.
 */

/** Media types presented as Show → Season → Episode groups. */
export const TV_TYPES = ['tv', 'anime', 'episode'];

/** Drop a trailing slash and lowercase — for comparing dirs to library roots. */
export function normPath(p: string): string {
  return p.replace(/[/\\]+$/, '').toLowerCase();
}

/** Strip a trailing `(YYYY)` from a folder name into title + year. */
export function parseFolderTitle(name: string): { title: string; year: number | null } {
  const m = name.match(/^(.*?)[\s._]*\((\d{4})\)\s*$/);
  if (m) return { title: m[1].trim(), year: Number(m[2]) };
  return { title: name.trim(), year: null };
}

/** A trailing year, on an ALREADY-normalized string ("ghosts 2021" → "ghosts"). */
const TRAILING_YEAR = /\s+(?:19|20)\d{2}$/;

/**
 * Canonical identity key for a show title or show-folder name — the single
 * definition shared by the scanner, the watchlist and the missing-episode sweep.
 *
 *   "Ghosts (US)"          → "ghosts us"
 *   "Ghosts US (2021)"     → "ghosts us"      (the folder)
 *   "Happy's Place (2024)" → "happys place"
 *   "Magnum P.I. (2018)"   → "magnum p i"
 *
 * `normalize` folds case, separators and apostrophes; the trailing year is dropped
 * so a folder and the bare title agree. This is EQUALITY on a canonical form, never
 * a substring test — "Ghosts US" and "Ghosts UK" stay distinct, as do "Rise" and
 * "Sunrise". A *leading* year survives, because it can be the whole title ("1883").
 */
export function showCanonicalKey(name: string): string {
  const n = normalize(name);
  return n.replace(TRAILING_YEAR, '').trim() || n;
}

export interface GroupInput {
  title: string;
  path: string;
}

export interface ResolvedGroup {
  /** Stable dedup key (`dir:<normalized>` | `title:<lower>`). */
  dedupKey: string;
  /** Kind + original value used to fetch the show's episodes. */
  kind: 'dir' | 'title';
  /** Original-case show folder (kind='dir') or exact title (kind='title'). */
  value: string;
  /** Display title parsed from the folder (or the item title at a library root). */
  title: string;
  /** Year parsed from a `(YYYY)` show folder, when present. */
  year: number | null;
}

/**
 * Resolve which show an item belongs to. `roots` are the normalized library-root
 * paths (a file whose show folder *is* a root has no show folder of its own).
 */
export function resolveGroup(item: GroupInput, roots: Set<string>): ResolvedGroup {
  const dir = showFolderRoot(item.path);
  const folder = path.basename(dir);
  const isShowFolder = folder !== '' && !roots.has(normPath(dir)) && !isSeasonContainer(folder);
  if (isShowFolder) {
    const parsed = parseFolderTitle(folder);
    return { dedupKey: `dir:${normPath(dir)}`, kind: 'dir', value: dir, title: parsed.title, year: parsed.year };
  }
  const title = item.title.trim();
  return { dedupKey: `title:${title.toLowerCase()}`, kind: 'title', value: title, title, year: null };
}

/** Encode a group's (kind,value) into a URL-safe token the browser round-trips. */
export function encodeSeriesKey(kind: 'dir' | 'title', value: string): string {
  return Buffer.from(`${kind}:${value}`, 'utf8').toString('base64url');
}

/** Decode a series key token back into a Prisma `where` fragment for its episodes. */
export function decodeSeriesKey(token: string): { kind: 'dir' | 'title'; value: string } {
  const raw = Buffer.from(token, 'base64url').toString('utf8');
  const idx = raw.indexOf(':');
  const kind = raw.slice(0, idx);
  const value = raw.slice(idx + 1);
  if (kind !== 'dir' && kind !== 'title') throw new Error('Invalid series key');
  if (!value) throw new Error('Invalid series key');
  return { kind, value };
}
