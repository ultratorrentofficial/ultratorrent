import * as path from 'node:path';

/**
 * Which library a torrent's files belong to, inferred from where they sit.
 *
 * A `library`-scoped policy has to know this, and most torrents carry no
 * recorded association — only the ones Media Intake imported do. On this
 * platform the libraries live INSIDE the download tree (qBittorrent saves to
 * `/downloads`; the Movies library is `/downloads/Movies/HD Movies`), so the
 * covering library root is a real answer rather than a guess, and it is the
 * same test the post-download pipeline already uses to decide which library a
 * completed download belongs to.
 *
 * Pure, so the containment rules can be argued about without a database.
 */

export interface LibraryRoot {
  id: string;
  path: string;
}

/** True when `child` is `parent` or sits beneath it. */
function isWithin(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  // A relative path that climbs out, or that is absolute, is not contained.
  // The empty string means the two are the same path, already handled above.
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The library owning `savePath`, or null.
 *
 * **The most specific root wins.** Libraries nest — `/downloads/Movies` can
 * contain `/downloads/Movies/HD Movies` — and a file under the deeper one is
 * covered by both. Returning the shallower would let a policy written for
 * "Movies" silently capture a torrent the operator thinks of as belonging to
 * "HD Movies", which is exactly the confusion scope precedence exists to avoid.
 *
 * Returns null rather than guessing when nothing covers the path: an unmatched
 * torrent simply inherits from the scope above, which is the correct meaning of
 * "no library policy applies to this".
 */
export function libraryForPath(
  savePath: string | null | undefined,
  libraries: readonly LibraryRoot[],
): string | null {
  if (!savePath) return null;

  let best: LibraryRoot | null = null;
  for (const lib of libraries) {
    if (!lib.path || !isWithin(savePath, lib.path)) continue;
    if (!best || path.resolve(lib.path).length > path.resolve(best.path).length) {
      best = lib;
    }
  }
  return best?.id ?? null;
}
