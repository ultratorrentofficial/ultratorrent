/**
 * Subtitle candidate scoring — pure, deterministic, unit-testable.
 *
 * Every candidate is scored against the media file's fingerprint + the library's
 * preferences into a normalized 0–100 quality score and a tier that decides what
 * happens next:
 *
 *   90+   auto    → download + validate + install automatically
 *   75–89 download → download, verify sync, install if it checks out
 *   50–74 present → surface to the user, never auto-install
 *   <50   reject  → discard
 *
 * The signed weights come from the module spec. Two invariants shape the design:
 *  1. An exact MOVIE-HASH match is a same-encode guarantee (the subtitle was
 *     timed against THIS file), so it FLOORS the score at the auto tier no matter
 *     what other metadata is missing — the whole point of hashing.
 *  2. A TITLE-ONLY match (no hash, no external id, no release) can never be
 *     trusted blindly; its raw sum lands it below auto so it is presented, not
 *     installed. The strategy layer additionally refuses to auto-accept level-4.
 */
import type { NormalizedSubtitle } from '../providers/subtitle-provider';

export type ScoreTier = 'auto' | 'download' | 'present' | 'reject';

/** Signed point weights (spec §Scoring Engine). Exported for tests + docs. */
export const SCORE_WEIGHTS = {
  movieHash: 50,
  fileSize: 10,
  externalId: 15,
  seasonEpisode: 15,
  releaseGroup: 10,
  source: 5,
  resolution: 3,
  runtime: 8,
  trustedUploader: 4,
  preferredProvider: 3,
  forced: 3,
  preferredLanguage: 5,
  machineTranslation: -20,
  wrongRuntime: -25,
  wrongEdition: -40,
  unknownRelease: -10,
} as const;

/** Runtime within this many seconds counts as a match (+8). */
export const RUNTIME_MATCH_TOLERANCE_SEC = 30;
/** Runtime off by more than this (both known) counts as wrong (−25). */
export const RUNTIME_WRONG_THRESHOLD_SEC = 120;

/** Media-file fingerprint + library preferences a candidate is scored against. */
export interface ScoringContext {
  movieHash?: string | null;
  fileSize?: number | null;
  imdbId?: string | null;
  tmdbId?: string | null;
  tvdbId?: string | null;
  season?: number | null;
  episode?: number | null;
  releaseGroup?: string | null;
  source?: string | null;
  resolution?: string | null;
  runtimeSec?: number | null;
  edition?: string | null;
  /** ISO-639-1 codes, in preference order. */
  preferredLanguages?: string[];
  /** Provider keys the library prefers. */
  preferredProviders?: string[];
  /** True when the library/request specifically wants forced tracks. */
  forcedRequested?: boolean;
}

export interface ScoreResult {
  /** Normalized 0–100. */
  score: number;
  tier: ScoreTier;
  /** Raw signed sum before normalization (can be negative). */
  raw: number;
  /** Per-signal contribution, for the "why this score?" UI. */
  breakdown: Record<string, number>;
}

const EDITIONS = ['extended', 'theatrical', 'directors cut', 'unrated', 'remastered', 'imax'];

const norm = (s?: string | null): string => (s ?? '').trim().toLowerCase();

/** Detect an explicit edition token in a release name, or null. Pure. */
function editionOf(text?: string | null): string | null {
  const t = norm(text).replace(/[._-]/g, ' ');
  for (const e of EDITIONS) if (t.includes(e) || (e === 'directors cut' && t.includes("director's cut"))) return e;
  return null;
}

/** Map a normalized score to its action tier. Pure. */
export function tierFor(score: number): ScoreTier {
  if (score >= 90) return 'auto';
  if (score >= 75) return 'download';
  if (score >= 50) return 'present';
  return 'reject';
}

/**
 * Score one candidate against the fingerprint/preferences. Pure — the same
 * inputs always yield the same result, and it performs no IO.
 */
export function scoreCandidate(cand: NormalizedSubtitle, ctx: ScoringContext): ScoreResult {
  const b: Record<string, number> = {};
  const add = (key: keyof typeof SCORE_WEIGHTS) => {
    b[key] = SCORE_WEIGHTS[key];
  };

  const hashMatch =
    !!cand.movieHash && !!ctx.movieHash && norm(cand.movieHash) === norm(ctx.movieHash);
  if (hashMatch) add('movieHash');

  if (
    cand.fileSize != null &&
    ctx.fileSize != null &&
    Number(cand.fileSize) === Number(ctx.fileSize)
  ) {
    add('fileSize');
  }

  const idMatch =
    (!!cand.imdbId && !!ctx.imdbId && norm(cand.imdbId) === norm(ctx.imdbId)) ||
    (!!cand.tmdbId && !!ctx.tmdbId && norm(cand.tmdbId) === norm(ctx.tmdbId)) ||
    (!!cand.tvdbId && !!ctx.tvdbId && norm(cand.tvdbId) === norm(ctx.tvdbId));
  if (idMatch) add('externalId');

  if (
    ctx.season != null &&
    ctx.episode != null &&
    cand.season === ctx.season &&
    cand.episode === ctx.episode
  ) {
    add('seasonEpisode');
  }

  const candRelease = `${cand.releaseName ?? ''} ${cand.filename ?? ''}`;
  if (ctx.releaseGroup && norm(candRelease).includes(norm(ctx.releaseGroup))) add('releaseGroup');
  if (ctx.source && norm(candRelease).includes(norm(ctx.source))) add('source');
  if (ctx.resolution && norm(candRelease).includes(norm(ctx.resolution))) add('resolution');

  // Runtime: a match rewards, a clear mismatch punishes, unknown/close is neutral.
  if (ctx.runtimeSec != null && cand.runtimeSec != null) {
    const delta = Math.abs(ctx.runtimeSec - cand.runtimeSec);
    if (delta <= RUNTIME_MATCH_TOLERANCE_SEC) add('runtime');
    else if (delta > RUNTIME_WRONG_THRESHOLD_SEC) add('wrongRuntime');
  }

  if (cand.trustedUploader) add('trustedUploader');
  if (ctx.preferredProviders?.some((p) => norm(p) === norm(cand.provider))) add('preferredProvider');
  if (ctx.forcedRequested && cand.forced) add('forced');
  if (ctx.preferredLanguages?.some((l) => norm(l) === norm(cand.language))) add('preferredLanguage');
  if (cand.machineTranslated) add('machineTranslation');

  // Wrong edition: only when BOTH editions are explicit and differ (extended sub
  // on a theatrical cut is worse than a generic sub — heavy penalty).
  const ctxEd = editionOf(ctx.edition);
  const candEd = editionOf(candRelease);
  if (ctxEd && candEd && ctxEd !== candEd) add('wrongEdition');

  // Unknown release: nothing to match on at all (no hash, no ids, no name).
  if (!hashMatch && !idMatch && !cand.releaseName && !cand.filename) add('unknownRelease');

  const raw = Object.values(b).reduce((s, v) => s + v, 0);
  let score = Math.max(0, Math.min(100, raw));
  // A same-encode hash match is trusted even when other metadata is sparse.
  if (hashMatch) score = Math.max(score, 90);

  return { score, tier: tierFor(score), raw, breakdown: b };
}
