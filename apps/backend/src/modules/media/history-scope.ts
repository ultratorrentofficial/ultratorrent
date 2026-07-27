/**
 * Which rename operations belong to one media item.
 *
 * Split out from the query so the rule is testable without a database — the
 * defect this replaces was a rule, not a query: the item detail page filtered a
 * page of the global log on `source` alone and, when nothing matched, fell back
 * to showing the twenty most recent operations library-wide. Every item with no
 * history of its own displayed another title's renames as if they were its own.
 */
import * as path from 'node:path';

export interface HistoryScope {
  /** Matched exactly, against both sides of an operation. */
  paths: string[];
  /** Matched as a prefix, so sidecars sharing a stem come along. */
  stems: string[];
}

/**
 * Build the scope for an item.
 *
 * `itemPath` is the media file itself (not its folder — the scanner stores the
 * file), and `filePaths` are the item's `MediaFile` rows, which for a multi-part
 * item are separate files.
 *
 * Three kinds of match, each earning its place:
 *
 * - **the paths themselves**, checked against `source` *and* `destination`. A
 *   rename's destination is the path the item now has, so matching only `source`
 *   misses the operation that produced its current name — which is every
 *   operation, once applied.
 * - **the containing folder**, so renaming `Movie (2018)/` or `Season 02/` shows
 *   up in the history of what was inside it.
 * - **the stem** (path minus extension), so `Movie (2018).en.srt` and
 *   `Movie (2018).nfo` are attributed to the film they sit beside.
 *
 * When a path carries no extension — a folder, or a dotfile like `.mkv`, for
 * which `extname` is empty by definition — the stem is the path itself. That is
 * the behaviour we want: as a prefix, a folder matches what is inside it, which
 * is precisely the sidecar rule one level up.
 */
export function historyScope(itemPath: string | null | undefined, filePaths: string[] = []): HistoryScope {
  const own = [itemPath, ...filePaths].filter((p): p is string => Boolean(p && p.trim()));
  if (!own.length) return { paths: [], stems: [] };

  const paths = [...new Set([...own, ...own.map((p) => path.dirname(p))])];

  const stems = [...new Set(own.map((p) => p.slice(0, p.length - path.extname(p).length)))];

  return { paths, stems };
}
