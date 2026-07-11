import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { parseTorrentName } from '../rss/torrent-name-parser';

/** The IMDb title types a TV show can legitimately resolve to. */
const SERIES_TYPES = ['tvSeries', 'tvMiniSeries'];

/**
 * How long a loaded title index stays hot. Long enough that one sweep — or a
 * `scanAll` over every monitored series — loads the catalogue once instead of
 * once per show; short enough that the memory is handed straight back after.
 */
const CACHE_TTL_MS = 60_000;

/** Same-titled candidates to episode-count before giving up (a title key with more
 * than a handful of hits is a generic name, not the show the user means). */
const MAX_CANDIDATES = 25;

/**
 * Punctuation- AND accent-insensitive title key for matching against the IMDb
 * catalogue. Folds accents to their base letter (NFD + drop combining marks), then
 * lowercases, turns `&` into `and`, and strips every remaining non-alphanumeric
 * char (incl. spaces) so `:` / `.` / `'` / spacing / diacritic differences all
 * collapse — e.g. "Chicago P.D." ↔ "Chicago PD", "FBI: Most Wanted" ↔ "FBI Most
 * Wanted", and (crucially) IMDb's "90 Day Fiancé" ↔ a library's "90 Day Fiance".
 * Folding must precede the strip: otherwise `é` is simply deleted, yielding
 * "90dayfianc" vs "90dayfiance" — a silent non-match.
 */
export function catalogueTitleKey(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // drop combining diacritical marks
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

/** A tracker/site stamp glued to the front of a release name ("www.UIndex.org - "). */
const TRACKER_PREFIX = /^\s*(?:www\.)?[\w-]+\.(?:com|org|net|info|me|to|tv|io|cc|eu|xyz)\s*-\s*/i;
/**
 * A trailing season (or season+episode) token. The release parser extracts the
 * season *number* but leaves the token in the title for a season pack — so
 * "Criminal.Minds.S18.1080p…" parses to the title "Criminal Minds S18", which
 * matches nothing. Stripping it here keeps that quirk out of the shared parser,
 * which the RSS match rules depend on.
 */
const TRAILING_SEASON = /[\s._-]+S\d{1,2}(?:\s*E\d{1,3})?\s*$/i;

/**
 * Ordered lookup attempts for a library folder name, most trustworthy first: the
 * name as-is, then the release-parsed title, then those with scene debris stripped.
 * A folder the renamer never touched is a raw release name
 * ("Ahsoka.S01E03.WEB.x264-TORRENTGALAXY[TGx]", "www.Torrenting.com - Black.Snow.S02E04…"),
 * and the catalogue holds none of that — it holds "Ahsoka" and "Black Snow".
 */
export function seriesLookupCandidates(
  rawTitle: string,
  year: number | null,
): Array<{ title: string; year: number | null }> {
  const attempts: Array<{ title: string; year: number | null }> = [];
  const add = (title: string | null | undefined, y: number | null) => {
    const t = title?.replace(TRAILING_SEASON, '').trim();
    if (!t) return;
    if (attempts.some((a) => a.title.toLowerCase() === t.toLowerCase())) return;
    attempts.push({ title: t, year: y });
  };

  add(rawTitle, year);
  // Strip the tracker stamp *before* parsing: the parser turns the dots into
  // spaces, after which "www.UIndex.org" no longer looks like a domain.
  const cleaned = rawTitle.replace(TRACKER_PREFIX, '').trim();
  const parsed = parseTorrentName(cleaned);
  add(parsed.title, parsed.year ?? year);
  add(cleaned, year);
  return attempts;
}

interface SeriesCandidate {
  tconst: string;
  startYear: number | null;
}

export interface ResolvedSeries {
  tconst: string;
  startYear: number | null;
  /** Episodes this title has in the local catalogue. Always > 0. */
  episodes: number;
}

/**
 * Narrow same-titled candidates using the year we know locally. IMDb's `startYear`
 * and a library folder's year routinely differ by one (a show premiering either
 * side of a new year), so ±1 still counts. When the year matches nothing we only
 * fall back to the year-less candidates if the title is *unambiguous* — with two
 * same-named shows and a year that fits neither, any pick would be a guess.
 */
function narrowByYear(candidates: SeriesCandidate[], year: number | null): SeriesCandidate[] {
  if (year == null || candidates.length === 0) return candidates;
  const near = candidates.filter((c) => c.startYear != null && Math.abs(c.startYear - year) <= 1);
  if (near.length > 0) return near;
  return candidates.length === 1 ? candidates : [];
}

/**
 * Resolves a show title (+ year) to its IMDb series tconst against the **local**
 * catalogue — no network.
 *
 * The whole TV slice of the catalogue (~325k `tvSeries`/`tvMiniSeries` rows, vs
 * ~8.9M titles overall) is loaded once and indexed in memory by
 * {@link catalogueTitleKey}. That is what makes this affordable: matching a title
 * case/punctuation/accent-insensitively in SQL means `ILIKE`, which no index can
 * serve — Postgres falls back to a parallel seq scan of all 8.9M rows, ~8s *per
 * show*. One 2.5s indexed load answers every show instead, and it folds accents
 * and punctuation for free.
 */
@Injectable()
export class ImdbSeriesResolver {
  private readonly logger = new Logger(ImdbSeriesResolver.name);
  private cache: { byKey: Map<string, SeriesCandidate[]>; expiresAt: number } | null = null;
  private evictTimer: NodeJS.Timeout | null = null;
  private loading: Promise<Map<string, SeriesCandidate[]>> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The tconst for `title` (+ `year`), or null when there is no confident match —
   * no title match, or no candidate has a single catalogued episode. Among
   * same-titled candidates the one with the most episodes wins (the real,
   * long-running series over a same-named stub — "9-1-1" 2018/143 eps beats
   * "9-1-1" 1991/0 eps); a tie goes to the later series.
   */
  async resolve(title: string, year: number | null): Promise<ResolvedSeries | null> {
    const key = catalogueTitleKey(title);
    if (!key) return null;
    const byKey = await this.index();
    const candidates = narrowByYear(byKey.get(key) ?? [], year);

    let best: ResolvedSeries | null = null;
    for (const c of candidates.slice(0, MAX_CANDIDATES)) {
      const episodes = await this.prisma.iMDbEpisode.count({ where: { parentTitleId: c.tconst } });
      const better =
        best == null
          ? episodes > 0
          : episodes > best.episodes ||
            (episodes === best.episodes && (c.startYear ?? 0) > (best.startYear ?? 0));
      if (better && episodes > 0) best = { tconst: c.tconst, startYear: c.startYear, episodes };
    }
    // A title with no catalogued episodes can't be scanned, and is far more likely
    // to be the wrong (stub) entry than the show the caller means.
    return best;
  }

  /**
   * Resolve a **library folder name**, which may still be a raw scene release the
   * renamer never touched. Tries {@link seriesLookupCandidates} in order and takes
   * the first confident match.
   */
  async resolveFolder(rawTitle: string, year: number | null): Promise<ResolvedSeries | null> {
    for (const attempt of seriesLookupCandidates(rawTitle, year)) {
      const hit = await this.resolve(attempt.title, attempt.year);
      if (hit) return hit;
    }
    return null;
  }

  /** Drop the cached index (tests; and frees the memory immediately). */
  reset(): void {
    if (this.evictTimer) clearTimeout(this.evictTimer);
    this.evictTimer = null;
    this.cache = null;
  }

  /** The title index, loading (and caching) the catalogue's TV slice on demand. */
  private async index(): Promise<Map<string, SeriesCandidate[]>> {
    const hot = this.cache;
    if (hot && hot.expiresAt > Date.now()) return hot.byKey;
    // Concurrent callers (a sweep and a scan overlapping) share one load rather
    // than each pulling 325k rows.
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<Map<string, SeriesCandidate[]>> {
    const started = Date.now();
    const rows = await this.prisma.iMDbTitle.findMany({
      where: { titleType: { in: SERIES_TYPES } },
      select: { tconst: true, primaryTitle: true, startYear: true },
    });
    const byKey = new Map<string, SeriesCandidate[]>();
    for (const row of rows) {
      const key = catalogueTitleKey(row.primaryTitle);
      if (!key) continue;
      const candidate = { tconst: row.tconst, startYear: row.startYear };
      const existing = byKey.get(key);
      if (existing) existing.push(candidate);
      else byKey.set(key, [candidate]);
    }

    if (this.evictTimer) clearTimeout(this.evictTimer);
    this.cache = { byKey, expiresAt: Date.now() + CACHE_TTL_MS };
    this.evictTimer = setTimeout(() => {
      this.cache = null;
      this.evictTimer = null;
    }, CACHE_TTL_MS);
    this.evictTimer.unref?.(); // never hold the process open
    this.logger.log(
      `Indexed ${rows.length} IMDb series titles (${byKey.size} distinct) in ${Date.now() - started}ms`,
    );
    return byKey;
  }
}
