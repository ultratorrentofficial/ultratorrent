/**
 * Path arithmetic for the file browser, mirroring `PathSafety` on the backend.
 *
 * The file API addresses entries by a "wire path" whose form depends on how
 * many roots the server exposes:
 *
 *  - **one root** — root-relative (`/Movies/a.mkv`). The root is implicit, so
 *    the absolute path is `root + wire`.
 *  - **several roots** — absolute (`/mnt/orico/TV Retro`). The relative form is
 *    ambiguous there (`/TV Shows` exists under every root and the string does
 *    not say which), so it is not used, and `/` becomes a virtual level whose
 *    entries are the roots themselves.
 *
 * Everything here is derived from the `roots` array the server returns with
 * every browse response (and from `GET /api/files/root`), so a client never has
 * to guess which convention is in play. Paths that came FROM the server should
 * be handed back verbatim; these helpers exist for the two places that must
 * construct a path themselves — breadcrumbs, and seeding the picker from a
 * stored absolute value.
 */

/** The virtual top level: the single root, or the list of roots. */
export const BROWSE_ROOT = '/';

const trimTrailing = (p: string) => p.replace(/\/+$/, '');

/** Whether the server is exposing more than one root (so wire paths are absolute). */
export function usesAbsolutePaths(roots: string[] | undefined): boolean {
  return (roots?.length ?? 0) > 1;
}

/** The root that contains `abs`, or undefined. */
export function rootFor(roots: string[] | undefined, abs: string | undefined): string | undefined {
  if (!abs) return undefined;
  return (roots ?? []).find((r) => {
    const root = trimTrailing(r);
    return abs === root || abs.startsWith(root + '/');
  });
}

/** Absolute on-disk path for a wire path — for display and for `onSelect`. */
export function wireToAbsolute(roots: string[] | undefined, wire: string): string {
  if (usesAbsolutePaths(roots)) {
    // Already absolute. The virtual root has no single absolute form.
    return wire === BROWSE_ROOT ? '' : wire;
  }
  const root = trimTrailing(roots?.[0] ?? '');
  if (!wire || wire === BROWSE_ROOT) return root;
  return root + wire;
}

/**
 * Wire path for an absolute path. Falls back to the virtual root when the path
 * is not inside any root — a stored setting can outlive the root it referred
 * to, and opening at the top is better than sending the server a path it will
 * refuse.
 */
export function absoluteToWire(roots: string[] | undefined, abs: string | undefined): string {
  if (!abs) return BROWSE_ROOT;
  if (usesAbsolutePaths(roots)) {
    return rootFor(roots, abs) ? abs : BROWSE_ROOT;
  }
  const root = trimTrailing(roots?.[0] ?? '');
  if (!root) return BROWSE_ROOT;
  if (abs === root) return BROWSE_ROOT;
  return abs.startsWith(root + '/') ? abs.slice(root.length) || BROWSE_ROOT : BROWSE_ROOT;
}

/** One breadcrumb: what to show, and the wire path to navigate to. */
export interface Crumb {
  label: string;
  path: string;
}

/**
 * Breadcrumbs BELOW the home crumb (callers render "home" themselves, pointing
 * at {@link BROWSE_ROOT}).
 *
 * Under several roots the first crumb is the containing root — otherwise
 * splitting an absolute path on `/` would offer `/mnt` as a crumb, which is
 * outside the boundary and would only produce a 403 when clicked.
 */
export function crumbsFor(roots: string[] | undefined, wire: string): Crumb[] {
  if (usesAbsolutePaths(roots)) {
    const root = rootFor(roots, wire);
    if (!root) return [];
    const base = trimTrailing(root);
    const rest = wire.slice(base.length).split('/').filter(Boolean);
    return [
      { label: base.split('/').filter(Boolean).pop() ?? base, path: base },
      ...rest.map((seg, i) => ({ label: seg, path: base + '/' + rest.slice(0, i + 1).join('/') })),
    ];
  }
  const segments = wire.split('/').filter(Boolean);
  return segments.map((seg, i) => ({
    label: seg,
    path: '/' + segments.slice(0, i + 1).join('/'),
  }));
}
