import * as path from 'node:path';

/**
 * Turning a burst of filesystem events into the fewest scans that cover them.
 *
 * A single file arriving is not one event. A torrent writing a 40 GB remux fires
 * hundreds as it grows, an unpack fires one per extracted file, and a rename
 * fires on both the old and new name — so a watcher that scanned per event would
 * scan the same folder hundreds of times and spend the whole burst competing
 * with the write it is reacting to. Two reductions apply, in this order:
 *
 *  1. **Collapse to directories.** A scan's unit is a folder, so twelve files
 *     landing in one season folder is one scan, not twelve.
 *  2. **Collapse to ancestors.** If a folder AND its parent both changed — which
 *     is what creating a folder and filling it looks like — scanning the parent
 *     already covers the child, and scanning both walks the child twice.
 *
 * Pure so the reduction is testable without a filesystem: the timing half lives
 * in the service, and it is the reduction that decides whether a busy library
 * costs one scan or four hundred.
 */

/** Trailing separators removed, so `/a/b` and `/a/b/` are one directory. */
function norm(dir: string): string {
  const trimmed = dir.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** Is `child` the same as, or beneath, `parent`? Segment-aware. */
export function isAtOrUnder(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p === '/' ? '/' : `${p}/`);
}

/**
 * The directories to scan for a set of changed paths.
 *
 * `cap` bounds the result: past it, a burst is answered by scanning the common
 * ancestor once instead of issuing an unbounded number of partial scans. A
 * library-wide reorganisation should cost one full scan, not two thousand small
 * ones — the partial scan is an optimisation for the ordinary case, and past
 * some size it stops being one.
 */
export function coalesceScanTargets(
  dirs: Iterable<string>,
  opts: { cap?: number; root?: string } = {},
): string[] {
  const cap = opts.cap ?? 25;
  const unique = [...new Set([...dirs].map(norm))].filter(Boolean);
  if (unique.length === 0) return [];

  // Shortest first, so a parent is always considered before its children.
  unique.sort((a, b) => a.length - b.length || a.localeCompare(b));

  const kept: string[] = [];
  for (const dir of unique) {
    if (!kept.some((k) => isAtOrUnder(dir, k))) kept.push(dir);
  }

  if (kept.length <= cap) return kept;

  /*
   * Over the cap. Fall back to the deepest directory that contains all of them,
   * bounded by the library root — never above it, or a scan would walk out of
   * the library entirely.
   */
  const root = opts.root ? norm(opts.root) : undefined;
  let common = kept[0]!;
  for (const dir of kept.slice(1)) {
    while (!isAtOrUnder(dir, common)) {
      const parent = path.dirname(common);
      if (parent === common) break;
      common = parent;
    }
  }
  if (root && !isAtOrUnder(common, root)) common = root;
  return [common];
}
