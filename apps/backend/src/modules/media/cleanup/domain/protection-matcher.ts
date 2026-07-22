import path from 'node:path';

/**
 * Protection matching — the pure core.
 *
 * A protection is an ABSOLUTE exclusion for automation: policy match + protected
 * target = automatic cleanup is forbidden, with no override and no scoring. This
 * module decides only "is this target protected, and by which rule" — it performs
 * no IO so it can be exhaustively tested, and so the executor can re-run it
 * immediately before touching the filesystem (the third protection check, which
 * closes the add-a-protection-mid-run race).
 *
 * Identity is by STABLE ID wherever possible. `canonicalPathSnapshot` on a stored
 * protection is audit/reconciliation only and is deliberately not consulted here —
 * a file that moved is still the same file, and matching it by its old path would
 * both miss it and, worse, protect whatever now occupies that path.
 */

export type ProtectionType = 'permanent' | 'temporary' | 'conditional' | 'legal_hold';

export type ProtectionTargetType =
  | 'media_file' | 'media_item' | 'show' | 'season' | 'episode' | 'library'
  | 'path_prefix' | 'tag' | 'collection' | 'watchlist' | 'torrent' | 'external_identity';

/** A stored protection, narrowed to what matching needs. */
export interface ProtectionRecord {
  id: string;
  targetType: ProtectionTargetType | string;
  protectionType: ProtectionType | string;
  reason: string;
  mediaItemId?: string | null;
  mediaFileId?: string | null;
  mediaShowId?: string | null;
  mediaLibraryId?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  externalIdentityKey?: string | null;
  pathPrefix?: string | null;
  tagValue?: string | null;
  collectionId?: string | null;
  torrentHash?: string | null;
  protectedUntil?: Date | null;
  revokedAt?: Date | null;
  conditionKind?: string | null;
  conditionConfig?: Record<string, unknown> | null;
  createdByUserId?: string | null;
  createdAt?: Date | null;
}

/** The facts about the thing being considered for cleanup. */
export interface ProtectionTarget {
  mediaItemId?: string | null;
  mediaFileId?: string | null;
  mediaShowId?: string | null;
  mediaLibraryId?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  /** e.g. ['imdb:tt0944947', 'tmdb:1396'] — every identity this target answers to. */
  externalIdentityKeys?: string[];
  /** Absolute canonical path. */
  path?: string | null;
  tags?: string[];
  collectionIds?: string[];
  onWatchlist?: boolean;
  torrentHash?: string | null;
  /** Facts conditional protections read. */
  maximumProgressPercent?: number | null;
  torrentRatio?: number | null;
  addedAt?: Date | null;
  hasActiveJob?: boolean;
  allSelectedUsersWatched?: boolean;
}

export interface ProtectionMatch {
  id: string;
  targetType: string;
  protectionType: string;
  reason: string;
  /** Which scope matched, for the UI's "why is this protected" explanation. */
  scope: string;
  protectedUntil: Date | null;
  createdByUserId: string | null;
  createdAt: Date | null;
}

export interface ProtectionVerdict {
  isProtected: boolean;
  /** A legal hold cannot be lifted by an ordinary cleanup operator. */
  hasLegalHold: boolean;
  matches: ProtectionMatch[];
}

/** True when `child` is inside `parent`, on a path-segment boundary. */
export function isPathInside(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const c = path.resolve(child);
  const p = path.resolve(parent);
  // Segment boundary matters: /media/Movies must not protect /media/Movies2/x.mkv.
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** Has this protection lapsed (revoked, or a temporary window that has passed)? */
export function isInactive(p: ProtectionRecord, now: Date): boolean {
  if (p.revokedAt) return true;
  if (p.protectedUntil && p.protectedUntil.getTime() <= now.getTime()) return true;
  return false;
}

/**
 * Conditional protections. Returns null when the condition cannot be evaluated —
 * and an unevaluable condition FAILS CLOSED (stays protective), because the whole
 * point of the registry is that uncertainty must not become deletion.
 */
function conditionHolds(p: ProtectionRecord, t: ProtectionTarget, now: Date): boolean {
  const cfg = (p.conditionConfig ?? {}) as Record<string, unknown>;
  switch (p.conditionKind) {
    case 'on_watchlist':
      return t.onWatchlist !== false;
    case 'partially_watched': {
      const floor = typeof cfg.minProgressPercent === 'number' ? cfg.minProgressPercent : 1;
      if (t.maximumProgressPercent == null) return true; // unknown → stays protected
      return t.maximumProgressPercent >= floor;
    }
    case 'torrent_ratio_below': {
      const limit = typeof cfg.ratio === 'number' ? cfg.ratio : null;
      if (limit == null || t.torrentRatio == null) return true;
      return t.torrentRatio < limit;
    }
    case 'recently_added': {
      const days = typeof cfg.days === 'number' ? cfg.days : null;
      if (days == null || !t.addedAt) return true;
      return now.getTime() - t.addedAt.getTime() < days * 86_400_000;
    }
    case 'job_active':
      return t.hasActiveJob !== false;
    case 'until_all_watched':
      return t.allSelectedUsersWatched !== true;
    default:
      // An unrecognised condition is not permission to delete.
      return true;
  }
}

/** Does this protection's scope cover the target? Returns the scope label, or null. */
function scopeMatch(p: ProtectionRecord, t: ProtectionTarget): string | null {
  switch (p.targetType) {
    case 'media_file':
      return p.mediaFileId && p.mediaFileId === t.mediaFileId ? 'file' : null;
    case 'media_item':
      return p.mediaItemId && p.mediaItemId === t.mediaItemId ? 'item' : null;
    case 'show':
      return p.mediaShowId && p.mediaShowId === t.mediaShowId ? 'show' : null;
    case 'season':
      return p.mediaShowId &&
        p.mediaShowId === t.mediaShowId &&
        p.seasonNumber != null &&
        p.seasonNumber === t.seasonNumber
        ? 'season'
        : null;
    case 'episode':
      return p.mediaShowId &&
        p.mediaShowId === t.mediaShowId &&
        p.seasonNumber != null && p.seasonNumber === t.seasonNumber &&
        p.episodeNumber != null && p.episodeNumber === t.episodeNumber
        ? 'episode'
        : null;
    case 'library':
      return p.mediaLibraryId && p.mediaLibraryId === t.mediaLibraryId ? 'library' : null;
    case 'path_prefix':
      return p.pathPrefix && t.path && isPathInside(t.path, p.pathPrefix) ? 'path' : null;
    case 'tag':
      return p.tagValue && (t.tags ?? []).some((x) => x.toLowerCase() === p.tagValue!.toLowerCase())
        ? 'tag'
        : null;
    case 'collection':
      return p.collectionId && (t.collectionIds ?? []).includes(p.collectionId) ? 'collection' : null;
    case 'watchlist':
      return t.onWatchlist === true ? 'watchlist' : null;
    case 'torrent':
      return p.torrentHash && t.torrentHash &&
        p.torrentHash.toLowerCase() === t.torrentHash.toLowerCase()
        ? 'torrent'
        : null;
    case 'external_identity':
      return p.externalIdentityKey &&
        (t.externalIdentityKeys ?? []).some(
          (k) => k.toLowerCase() === p.externalIdentityKey!.toLowerCase(),
        )
        ? 'identity'
        : null;
    default:
      return null;
  }
}

/**
 * Evaluate every protection against one target. Pure and order-independent; the
 * result lists EVERY matching rule so the UI can explain all of them rather than
 * just the first.
 */
export function evaluateProtections(
  target: ProtectionTarget,
  protections: ProtectionRecord[],
  now: Date = new Date(),
): ProtectionVerdict {
  const matches: ProtectionMatch[] = [];

  for (const p of protections) {
    if (isInactive(p, now)) continue;
    const scope = scopeMatch(p, target);
    if (!scope) continue;
    if (p.protectionType === 'conditional' && !conditionHolds(p, target, now)) continue;

    matches.push({
      id: p.id,
      targetType: String(p.targetType),
      protectionType: String(p.protectionType),
      reason: p.reason,
      scope,
      protectedUntil: p.protectedUntil ?? null,
      createdByUserId: p.createdByUserId ?? null,
      createdAt: p.createdAt ?? null,
    });
  }

  return {
    isProtected: matches.length > 0,
    hasLegalHold: matches.some((m) => m.protectionType === 'legal_hold'),
    matches,
  };
}
