/**
 * Progressive search strategy (pure query planning).
 *
 * UltraTorrent searches in progressively-relaxed LEVELS, most-confident first,
 * and stops as soon as a level yields a good-enough candidate — so a perfect
 * hash match is never diluted by fuzzy title results:
 *
 *   LEVEL 1  exact movie hash      (+ file size)   → highest confidence
 *   LEVEL 2  release match         (name/group/source/resolution)
 *   LEVEL 3  external ids          (imdb/tmdb/tvdb + season/episode/year)
 *   LEVEL 4  title search          (title/year/season/episode)
 *
 * A LEVEL-4 (title-only) result is NEVER auto-accepted; the strategy tags it so
 * the pipeline presents rather than installs it, regardless of score.
 *
 * This module only PLANS the per-level sub-queries (pure, testable). The service
 * runs them against providers and applies scoring.
 */
import type { SubtitleSearchQuery } from '../providers/subtitle-provider';

export interface SearchLevel {
  level: 1 | 2 | 3 | 4;
  label: string;
  /** The sub-query to issue at this level (a narrowed view of the full query). */
  query: SubtitleSearchQuery;
}

/**
 * Build the ordered, progressively-relaxed levels for a fingerprint-derived
 * query, skipping any level whose signals are absent (no hash → no level 1, no
 * external id → no level 3). `languages`/HI/forced ride along on every level.
 * Pure.
 */
export function buildSearchLevels(q: SubtitleSearchQuery): SearchLevel[] {
  const common = {
    languages: q.languages,
    hearingImpaired: q.hearingImpaired,
    forced: q.forced,
    runtimeSec: q.runtimeSec ?? null,
    mediaType: q.mediaType ?? null,
  };
  const levels: SearchLevel[] = [];

  if (q.movieHash) {
    levels.push({
      level: 1,
      label: 'movie hash',
      query: { ...common, movieHash: q.movieHash, fileSize: q.fileSize ?? null },
    });
  }
  if (q.releaseName || q.releaseGroup) {
    levels.push({
      level: 2,
      label: 'release match',
      query: {
        ...common,
        releaseName: q.releaseName ?? null,
        releaseGroup: q.releaseGroup ?? null,
        title: q.title ?? null,
        season: q.season ?? null,
        episode: q.episode ?? null,
      },
    });
  }
  if (q.imdbId || q.tmdbId || q.tvdbId) {
    levels.push({
      level: 3,
      label: 'external id',
      query: {
        ...common,
        imdbId: q.imdbId ?? null,
        tmdbId: q.tmdbId ?? null,
        tvdbId: q.tvdbId ?? null,
        season: q.season ?? null,
        episode: q.episode ?? null,
        year: q.year ?? null,
      },
    });
  }
  if (q.title) {
    levels.push({
      level: 4,
      label: 'title',
      query: {
        ...common,
        title: q.title,
        year: q.year ?? null,
        season: q.season ?? null,
        episode: q.episode ?? null,
      },
    });
  }
  return levels;
}

/** True when a match at this level may be auto-installed (level 4 never is). */
export function levelAllowsAutoAccept(level: number): boolean {
  return level >= 1 && level <= 3;
}
