import { Logger } from '@nestjs/common';
import { languageAllowed } from '@ultratorrent/shared';
import type { DiscoveryCapability, ReleaseType } from '@ultratorrent/shared';
import type {
  DiscoveryProviderHealth,
  DiscoveryQuery,
  RawDiscovery,
  ReleaseDiscoveryProvider,
} from './discovery-provider';
import { htmlToText } from '../../common/html-text';

const BASE = 'https://api.tvmaze.com';
/** The full schedule is ~12 MB. Generous, and only ever on a background sync. */
const TIMEOUT_MS = 60_000;
/**
 * How long one fetch of the full schedule is reused.
 *
 * A sync asks this provider four different questions, and each is a different
 * slice of the SAME document. Re-downloading 12 MB per question would be four
 * times the traffic for identical bytes.
 */
const SCHEDULE_TTL_MS = 10 * 60_000;
/** Refuse an implausibly large body rather than buffering whatever arrives. */
const MAX_SCHEDULE_BYTES = 64 * 1024 * 1024;

/** TVmaze `show.status` → the vocabulary `TvShowStatus` already uses. */
const STATUS: Record<string, string> = {
  Running: 'continuing',
  Ended: 'ended',
  'To Be Determined': 'unknown',
  'In Development': 'planned',
};

/**
 * TVmaze as a discovery source: television only, no API key.
 *
 * Built on `/schedule/full` rather than `/schedule?date=…`. That endpoint returns
 * every scheduled episode in one response — measured at 6,242 episodes across
 * 2026-09-03 → 2028-03-05, with the show EMBEDDED (genres, status, externals,
 * language) — so a 90-day window costs one request instead of ninety. TVmaze
 * asks for restraint rather than publishing a hard quota, and ninety calls per
 * template per sync is not restraint.
 *
 * Two properties of the data shape what this provider does and does not do:
 *
 *  - **The schedule is dominated by daily news and talk.** A single US day
 *    carries 87 episodes, most of them programmes like *Bloomberg Daybreak:
 *    Europe* (season 2026, episode 144). They are reported faithfully with their
 *    real (usually empty) genre list, because filtering them here would be the
 *    category policy's job done in the wrong place — and an empty genre list is
 *    exactly what makes them fail an auto-monitor match.
 *  - **`externals` is frequently all null.** Many shows have no TVDB or IMDb id
 *    at all, so TVmaze's own id is the only stable identity. That is enough to
 *    key a record, and not enough to auto-monitor on its own — which is the
 *    identity gate's decision, not this provider's.
 */
export class TvmazeDiscoveryProvider implements ReleaseDiscoveryProvider {
  readonly name = 'tvmaze';
  private readonly logger = new Logger(TvmazeDiscoveryProvider.name);
  private cache: { at: number; rows: any[] } | null = null;

  capabilities(): DiscoveryCapability[] {
    // No movies: TVmaze is television only. No trending/popular: it publishes
    // neither, and claiming them would return empty arrays that read as "nothing
    // is trending" rather than "this source cannot say".
    return ['upcoming_series', 'upcoming_seasons', 'upcoming_episodes', 'returning_series', 'details'];
  }

  async healthCheck(): Promise<DiscoveryProviderHealth> {
    const started = Date.now();
    try {
      const res = await fetch(`${BASE}/shows/1`, { signal: AbortSignal.timeout(10_000) });
      return res.ok
        ? { healthy: true, responseMs: Date.now() - started }
        : { healthy: false, message: `TVmaze returned ${res.status}.` };
    } catch {
      return { healthy: false, message: 'TVmaze is unreachable.' };
    }
  }

  /** A series premiere is season 1, episode 1. */
  async getUpcomingSeries(q: DiscoveryQuery): Promise<RawDiscovery[]> {
    return this.slice(q, (e) => e.season === 1 && e.number === 1, 'series_premiere');
  }

  /** A season premiere is episode 1 of any later season. */
  async getUpcomingSeasons(q: DiscoveryQuery): Promise<RawDiscovery[]> {
    return this.slice(q, (e) => e.number === 1 && Number(e.season) > 1, 'season_premiere');
  }

  async getUpcomingEpisodes(q: DiscoveryQuery): Promise<RawDiscovery[]> {
    return this.slice(q, () => true, 'episode_air');
  }

  /**
   * Shows already running that have an episode in the window.
   *
   * Deliberately not "everything in the schedule": a show whose status is `Ended`
   * can still appear — a repeat, or a trailing special — and reporting it as
   * returning would be wrong.
   */
  async getReturningSeries(q: DiscoveryQuery): Promise<RawDiscovery[]> {
    return this.slice(
      q,
      (e) => (e._embedded?.show ?? e.show)?.status === 'Running',
      'episode_air',
    );
  }

  async getDetails(externalId: string): Promise<RawDiscovery | null> {
    try {
      const res = await fetch(`${BASE}/shows/${encodeURIComponent(externalId)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      return this.mapShow(await res.json(), null, 'unknown');
    } catch {
      return null;
    }
  }

  // --- internals -----------------------------------------------------------
  /**
   * One slice of the schedule: filter, window, then collapse to one row per SHOW.
   *
   * Collapsing matters — a daily programme contributes ninety episodes to a
   * ninety-day window, and ninety discoveries of one show is ninety rows saying
   * the same thing. The EARLIEST qualifying episode is kept, because the question
   * being asked is "when does this next happen".
   */
  private async slice(
    q: DiscoveryQuery,
    keep: (episode: any) => boolean,
    releaseType: ReleaseType,
  ): Promise<RawDiscovery[]> {
    const { from, to } = window(q);
    const rows = await this.schedule();

    const bestByShow = new Map<number, any>();
    for (const e of rows) {
      const airdate = typeof e?.airdate === 'string' ? e.airdate : null;
      if (!airdate || airdate < from || airdate > to) continue;
      if (!keep(e)) continue;
      const show = e._embedded?.show ?? e.show;
      if (!matchesLocale(show, q)) continue;
      const id = Number(show?.id);
      if (!Number.isFinite(id)) continue;
      const current = bestByShow.get(id);
      if (!current || airdate < current.airdate) bestByShow.set(id, e);
    }

    const out: RawDiscovery[] = [];
    for (const e of bestByShow.values()) {
      const show = e._embedded?.show ?? e.show;
      out.push(this.mapShow(show, e, releaseType));
      if (q.limit && out.length >= q.limit) break;
    }
    return out;
  }

  private mapShow(show: any, episode: any | null, releaseType: ReleaseType): RawDiscovery {
    const externalIds: RawDiscovery['externalIds'] = {};
    if (show?.id != null) externalIds.tvmaze = String(show.id);
    const ext = show?.externals ?? {};
    if (ext.thetvdb) externalIds.tvdb = String(ext.thetvdb);
    if (ext.imdb) externalIds.imdb = String(ext.imdb);

    const premiered = isoDate(show?.premiered);
    const airdate = isoDate(episode?.airdate);
    /*
     * `airstamp` is the one field here that is a real INSTANT — TVmaze publishes
     * it with an offset, e.g. 2026-09-06T04:00:00+00:00. `airdate` is the
     * network's local calendar date and cannot be converted to a viewer's zone
     * without moving it a day, which is why both are carried rather than one.
     */
    const airsAt = instant(episode?.airstamp);
    const webChannel = show?.webChannel?.name ?? null;

    return {
      mediaType: 'tv',
      title: String(show?.name ?? ''),
      year: premiered ? Number(premiered.slice(0, 4)) : null,
      externalIds,
      genres: Array.isArray(show?.genres) ? show.genres.map(String) : [],
      originalLanguage: show?.language ?? null,
      network: show?.network?.name ?? webChannel,
      streamingService: webChannel,
      overview: stripHtml(show?.summary),
      posterUrl: show?.image?.original ?? show?.image?.medium ?? null,
      rating: num(show?.rating?.average),
      seriesStatus: STATUS[String(show?.status)] ?? 'unknown',
      seasonNumber: episode?.season != null ? Number(episode.season) : null,
      episodeNumber: episode?.number != null ? Number(episode.number) : null,
      premiereDate: premiered,
      /*
       * TVmaze schedules by the network's local AIRTIME, so a late-night episode
       * carries the previous calendar date — asking for 2026-09-10 returns rows
       * dated 2026-09-09. The date is reported exactly as published rather than
       * shifted, and the confidence says it is a schedule entry, not a
       * confirmation.
       */
      releaseDates: airdate ? [{ releaseType, date: airdate, airsAt, confidence: 0.7 }] : [],
    };
  }

  /** The full schedule, reused for the life of the TTL. */
  private async schedule(): Promise<any[]> {
    if (this.cache && Date.now() - this.cache.at < SCHEDULE_TTL_MS) return this.cache.rows;
    try {
      const res = await fetch(`${BASE}/schedule/full`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) {
        this.logger.warn(`TVmaze /schedule/full → ${res.status}`);
        return this.cache?.rows ?? [];
      }
      const length = Number(res.headers.get('content-length') ?? 0);
      if (length > MAX_SCHEDULE_BYTES) {
        this.logger.warn(`TVmaze /schedule/full is ${length} bytes — refusing`);
        return this.cache?.rows ?? [];
      }
      const rows = await res.json();
      if (!Array.isArray(rows)) return this.cache?.rows ?? [];
      this.cache = { at: Date.now(), rows };
      return rows;
    } catch (err) {
      this.logger.warn(`TVmaze /schedule/full failed: ${(err as Error).message}`);
      // Serve the previous copy rather than reporting an empty schedule: "the
      // fetch failed" and "nothing is airing" must not look the same.
      return this.cache?.rows ?? [];
    }
  }
}

// --- helpers ---------------------------------------------------------------
/**
 * Does this show belong to the locale the template asked for?
 *
 * `/schedule/full` is GLOBAL. Measured on the live feed: 3,430 English rows
 * against 541 Chinese, 384 Japanese, 238 Korean and 214 Russian, and a 90-day
 * premiere slice with no filter came back almost entirely non-English — Russian,
 * Thai, Turkish, Dutch and Chinese daily programming. A template scoped to
 * English/US would have been handed all of it.
 *
 * TVmaze names languages in ENGLISH WORDS (`"English"`, `"Japanese"`), not ISO
 * codes, so a two-letter code from the template is matched against a small alias
 * table as well as the word itself. An unmatched code falls back to comparing
 * the raw strings rather than silently dropping every show.
 *
 * Region comes from the network's country code; a web-only show has no network,
 * so it is judged on language alone rather than excluded for lacking a country
 * it was never going to have.
 *
 * An empty list means "anywhere", because that is what a template that named
 * nothing asked for.
 */
/*
 * The alias table moved to `@ultratorrent/shared` (`canonicalLanguage`). It used
 * to live here and be used only to filter what THIS provider returned, which is
 * why the policy — comparing a stored value against a template — never got the
 * benefit of it, and why `en` never matched `English`.
 */

function matchesLocale(show: any, q: DiscoveryQuery): boolean {
  if (q.languages?.length) {
    if (!languageAllowed(show?.language, q.languages)) return false;
  }
  if (q.regions?.length) {
    const country = show?.network?.country?.code ?? show?.webChannel?.country?.code ?? null;
    // No country at all — a web-only show — is not evidence against it.
    if (country && !q.regions.some((r) => r.toUpperCase() === String(country).toUpperCase())) {
      return false;
    }
  }
  return true;
}

function window(q: DiscoveryQuery): { from: string; to: string } {
  const now = new Date();
  const end = new Date(now.getTime() + Math.max(1, q.windowDays) * 24 * 3600 * 1000);
  return { from: now.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function isoDate(v: unknown): string | null {
  if (typeof v !== 'string' || v.length < 10) return null;
  const d = v.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) ? d : null;
}

/**
 * A provider-stated instant, or null.
 *
 * Requires a time component: TVmaze returns `airstamp` for every entry, but for
 * a show with no announced airtime it is midnight in the network's zone, which
 * is a placeholder rather than a fact. Those are left to the calendar date.
 */
function instant(v: unknown): string | null {
  if (typeof v !== 'string' || !v.includes('T')) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * TVmaze summaries are HTML fragments (`<p><b>Title</b> is …</p>`).
 *
 * Tags are stripped rather than escaped downstream because this text is provider
 * input rendered in the Discover UI, and the safe form to store is the one with
 * no markup in it at all.
 */
function stripHtml(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  /*
   * `htmlToText` rather than a chain of replaces, which had this wrong twice.
   *
   * Tags were stripped BEFORE entities were decoded, so `&lt;script&gt;` — which
   * contains no literal `<` — survived the strip and was then decoded into real
   * markup by the very next line. And the strip was a single pass, so
   * `<scr<script>ipt>` became `<script>` by having its inner tag removed.
   */
  const text = htmlToText(v).replace(/\s+/g, ' ').trim();
  return text || null;
}
