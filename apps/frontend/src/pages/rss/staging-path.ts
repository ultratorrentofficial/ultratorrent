/**
 * The staging path a managed rule should save into.
 *
 * A managed rule may not download into a library: intake would import that
 * library back into itself and leave a duplicate of every episode, so the
 * server refuses the pair outright. That refusal is correct, but on its own it
 * makes the operator work out the answer by hand — the save path arrives
 * pre-filled with the library folder (that is what every rule had before
 * intake), and switching the mode turns a valid rule into a rejected one with
 * no obvious next step.
 *
 * The answer is derivable, so it should be offered rather than demanded. The
 * show folder is kept exactly as written — `Lanterns (2026)` stays
 * `Lanterns (2026)` — because it is the name the operator already chose and the
 * same convention the missing-episode grabber uses when it invents a staging
 * path of its own.
 */

const trimSlashes = (s: string): string => s.trim().replace(/\/+$/, '');

/** Is `path` the same as, or inside, `root`? */
export function isInside(path: string, root: string): boolean {
  const p = trimSlashes(path);
  const r = trimSlashes(root);
  if (!p || !r) return false;
  return p === r || p.startsWith(`${r}/`);
}

/**
 * What to suggest, or null when nothing needs changing.
 *
 * Returns null when the mode is not managed, when there is no staging root to
 * offer, when the path is already staged, or when it is not in a library —
 * a rule pointing somewhere else entirely is the operator's business, and
 * rewriting it would be presumptuous rather than helpful.
 */
export function stagingSuggestionFor(input: {
  importMode: string;
  savePath: string;
  stagingRoot?: string | null;
  libraryPaths: string[];
}): string | null {
  if (input.importMode !== 'managed_intake') return null;
  const path = trimSlashes(input.savePath ?? '');
  const staging = trimSlashes(input.stagingRoot ?? '');
  if (!path || !staging) return null;
  if (isInside(path, staging)) return null;
  if (!input.libraryPaths.some((lib) => isInside(path, lib))) return null;

  // Keep the folder the operator named; only the root changes.
  const folder = path.split('/').filter(Boolean).pop();
  return folder ? `${staging}/${folder}` : staging;
}
