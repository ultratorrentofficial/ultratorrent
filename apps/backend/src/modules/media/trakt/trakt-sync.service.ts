/**
 * Trakt synchronisation: collection, watched state, ratings, watchlist.
 *
 * Two rules govern every direction here, and both exist because a sync loop that
 * gets them wrong is *silently* destructive:
 *
 * 1. **Never echo.** A row that came FROM Trakt is never pushed BACK to Trakt.
 *    Without that, every sync replays their own history at them, re-dating
 *    watches and multiplying plays. Hence `source` on every row: we push what we
 *    observed, we accept what they own.
 *
 * 2. **Identity is a key, not a bag of nullable ids.** `imdb:tt0944947/s1e1`.
 *    Postgres will not dedupe a UNIQUE over nullable columns (NULL != NULL), so
 *    an item lacking a tmdb id would be re-inserted on every single sync. The
 *    key also gives us a stable handle for items Trakt knows and we don't.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import type { AuditContext } from '../media-metadata.service';
import { TraktAuthService } from './trakt-auth.service';
import { TraktClient, toTraktIds, hasAnyId, type TraktIds } from './trakt-client';

export interface SyncSummary {
  pulled: number;
  pushed: number;
  skipped: number;
}

export interface WatchlistImportSummary {
  found: number;
  imported: number;
  alreadyPresent: number;
  skipped: number;
}

export interface ItemIdentity {
  imdbId?: string | null;
  tmdbId?: string | null;
  tvdbId?: string | null;
  title?: string | null;
  showTitle?: string | null;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
}

/**
 * The stable identity of a watch/rating. Prefers a real id; falls back to a
 * normalised title so a title-only item still dedupes against itself instead of
 * being re-imported forever.
 *
 * Pure — exported and tested, because a change here silently duplicates or
 * silently merges every row in the table.
 */
export function watchKey(item: ItemIdentity): string {
  const base = item.imdbId
    ? `imdb:${item.imdbId}`
    : item.tmdbId
      ? `tmdb:${item.tmdbId}`
      : item.tvdbId
        ? `tvdb:${item.tvdbId}`
        : `title:${(item.showTitle ?? item.title ?? 'unknown')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ')}${item.year ? ` (${item.year})` : ''}`;

  // An episode's key must carry its numbering even when the id IS the episode's:
  // two different ids for the same episode (imdb vs tvdb) would otherwise produce
  // two rows, and a show-level id would collapse a whole series into one.
  return item.season != null && item.episode != null
    ? `${base}/s${item.season}e${item.episode}`
    : base;
}

/** Trakt's `{ ids }` shape from our loose columns. */
function identityIds(item: ItemIdentity): TraktIds {
  return toTraktIds({
    ...(item.imdbId ? { imdb: item.imdbId } : {}),
    ...(item.tmdbId ? { tmdb: item.tmdbId } : {}),
    ...(item.tvdbId ? { tvdb: item.tvdbId } : {}),
  });
}

@Injectable()
export class TraktSyncService {
  private readonly logger = new Logger(TraktSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: TraktAuthService,
    private readonly audit: AuditService,
  ) {}

  private async client(): Promise<TraktClient> {
    const creds = await this.auth.credentials();
    if (!creds) throw new NotFoundException('Trakt is not configured.');
    return new TraktClient(creds);
  }

  // -------------------------------------------------------------------------
  // Watchlist: Trakt → UltraTorrent's acquisition watchlist
  // -------------------------------------------------------------------------

  /**
   * Import the user's Trakt watchlist as acquisition watchlist items — i.e. the
   * things UltraTorrent will then go and hunt for.
   *
   * This is the one sync that causes DOWNLOADS, so it is careful: every item
   * carries the external ids Trakt gave us, which is precisely what the show
   * identity gates need (a title alone is how "The Librarians" becomes the wrong
   * Librarians). An item we cannot identify is skipped, not guessed at.
   */
  async importWatchlist(userId: string, ctx: AuditContext = {}): Promise<WatchlistImportSummary> {
    const token = await this.auth.accessTokenFor(userId);
    const client = await this.client();
    const summary: WatchlistImportSummary = { found: 0, imported: 0, alreadyPresent: 0, skipped: 0 };

    const { items: entries } = await client.getAll<any>('/sync/watchlist', token);
    summary.found = entries.length;

    for (const entry of entries) {
      const isShow = entry.type === 'show';
      const node = isShow ? entry.show : entry.movie;
      if (!node?.title) {
        summary.skipped++;
        continue;
      }

      const externalIds: Record<string, string> = {};
      for (const k of ['imdb', 'tmdb', 'tvdb', 'trakt'] as const) {
        if (node.ids?.[k]) externalIds[k] = String(node.ids[k]);
      }

      // Dedupe against what is already being watched for. Match on an external id
      // first — two shows can share a title, and that is exactly the collision
      // that has bitten this library before.
      const existing = await this.findExistingWatchlistItem(node.title, node.year, externalIds);
      if (existing) {
        // Backfill ids onto an item that was created title-only: it upgrades a
        // fuzzy item into an identified one, which is a strict improvement.
        if (!existing.externalIds && Object.keys(externalIds).length) {
          await this.prisma.mediaAcquisitionWatchlistItem.update({
            where: { id: existing.id },
            data: { externalIds },
          });
        }
        summary.alreadyPresent++;
        continue;
      }

      await this.prisma.mediaAcquisitionWatchlistItem.create({
        data: {
          type: isShow ? 'series' : 'movie',
          title: node.title,
          normalizedTitle: String(node.title).trim().toLowerCase(),
          year: node.year ?? null,
          externalIds,
          status: 'active',
          createdBy: userId,
        },
      });
      summary.imported++;
    }

    await this.prisma.traktAccount.update({
      where: { userId },
      data: { lastWatchlistSyncAt: new Date() },
    });
    await this.audit.record({
      userId: ctx.userId ?? userId,
      action: 'media.trakt.watchlist_imported',
      objectType: 'trakt_account',
      objectId: userId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { ...summary },
    });
    return summary;
  }

  private async findExistingWatchlistItem(
    title: string,
    year: number | null | undefined,
    externalIds: Record<string, string>,
  ) {
    for (const [provider, id] of Object.entries(externalIds)) {
      if (provider === 'trakt') continue; // ours-vs-theirs: a trakt id says nothing about OUR items
      const hit = await this.prisma.mediaAcquisitionWatchlistItem.findFirst({
        where: { externalIds: { path: [provider], equals: id } },
      });
      if (hit) return hit;
    }
    return this.prisma.mediaAcquisitionWatchlistItem.findFirst({
      where: {
        normalizedTitle: title.trim().toLowerCase(),
        ...(year ? { year } : {}),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Collection: UltraTorrent library → Trakt
  // -------------------------------------------------------------------------

  /**
   * Push what we OWN to Trakt's collection.
   *
   * Only items carrying a real external id are sent. Trakt will match on a fuzzy
   * title if asked, and would happily add the wrong film to someone's collection;
   * an unidentified item is skipped instead.
   */
  async pushCollection(userId: string, ctx: AuditContext = {}): Promise<SyncSummary> {
    const token = await this.auth.accessTokenFor(userId);
    const client = await this.client();
    const summary: SyncSummary = { pulled: 0, pushed: 0, skipped: 0 };

    const items = await this.prisma.mediaItem.findMany({
      where: { mediaType: { in: ['movie', 'tv', 'anime'] } },
      select: {
        mediaType: true,
        title: true,
        year: true,
        season: true,
        episode: true,
        externalIds: { select: { provider: true, externalId: true } },
      },
    });

    const movies: any[] = [];
    // Trakt groups episodes under their show, so the payload is show → seasons →
    // episodes rather than a flat list.
    const shows = new Map<string, { ids: TraktIds; seasons: Map<number, Set<number>> }>();

    for (const item of items) {
      const ids = toTraktIds(
        Object.fromEntries(item.externalIds.map((x) => [x.provider, x.externalId])),
      );
      if (!hasAnyId(ids)) {
        summary.skipped++;
        continue;
      }
      if (item.mediaType === 'movie') {
        movies.push({ ids });
        continue;
      }
      if (item.season == null || item.episode == null) {
        summary.skipped++;
        continue;
      }
      const key = JSON.stringify(ids);
      const show = shows.get(key) ?? { ids, seasons: new Map() };
      const season = show.seasons.get(item.season) ?? new Set<number>();
      season.add(item.episode);
      show.seasons.set(item.season, season);
      shows.set(key, show);
    }

    const showPayload = [...shows.values()].map((s) => ({
      ids: s.ids,
      seasons: [...s.seasons.entries()].map(([number, eps]) => ({
        number,
        episodes: [...eps].map((n) => ({ number: n })),
      })),
    }));

    if (movies.length || showPayload.length) {
      await client.post('/sync/collection', { movies, shows: showPayload }, token);
      summary.pushed = movies.length + showPayload.reduce(
        (n, s) => n + s.seasons.reduce((m, se) => m + se.episodes.length, 0),
        0,
      );
    }

    await this.prisma.traktAccount.update({
      where: { userId },
      data: { lastCollectionSyncAt: new Date() },
    });
    await this.audit.record({
      userId: ctx.userId ?? userId,
      action: 'media.trakt.collection_pushed',
      objectType: 'trakt_account',
      objectId: userId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { ...summary },
    });
    return summary;
  }

  // -------------------------------------------------------------------------
  // Watched state — both directions
  // -------------------------------------------------------------------------

  async syncWatched(userId: string, ctx: AuditContext = {}): Promise<SyncSummary> {
    const token = await this.auth.accessTokenFor(userId);
    const client = await this.client();
    const summary: SyncSummary = { pulled: 0, pushed: 0, skipped: 0 };

    // --- pull: Trakt's history becomes rows with source 'trakt' -------------
    // EVERY page. Trakt reports the page count in a header, so a single request
    // returns the most recent N and looks exactly like a complete result.
    const { items: history, truncated } = await client.getAll<any>('/sync/history', token);
    if (truncated) {
      this.logger.warn(
        `Trakt history for ${userId} exceeded the page ceiling — the oldest entries were not pulled.`,
      );
    }
    for (const entry of history) {
      const identity = this.identityFromTraktEntry(entry);
      if (!identity) {
        summary.skipped++;
        continue;
      }
      const key = watchKey(identity);
      const created = await this.prisma.mediaUserWatch.upsert({
        where: { userId_key: { userId, key } },
        create: {
          userId,
          key,
          mediaType: identity.season != null ? 'episode' : 'movie',
          imdbId: identity.imdbId ?? null,
          tmdbId: identity.tmdbId ?? null,
          tvdbId: identity.tvdbId ?? null,
          showTitle: identity.showTitle ?? null,
          title: identity.title ?? null,
          season: identity.season ?? null,
          episode: identity.episode ?? null,
          watchedAt: new Date(entry.watched_at ?? Date.now()),
          source: 'trakt',
          // Marked as already synced: it came FROM Trakt, so pushing it back
          // would re-date their own history.
          syncedAt: new Date(),
        },
        update: {},
      });
      if (created) summary.pulled++;
    }

    // --- push: our observed watches that Trakt has not seen ----------------
    // Drained in batches rather than capped at one: a single `take` would leave
    // the rest silently unsynced and still report success, which is the same
    // trap the un-paginated pull fell into. `skipped` rows have no id and would
    // be re-selected forever, so the loop advances past them by id.
    const BATCH = 1000;
    // A ceiling on the drain loop. If a batch is pushed but never leaves the
    // working set — a failed stamp, a bad query — the loop would otherwise POST
    // to Trakt forever. Bounded and LOUD beats unbounded and silent.
    const MAX_BATCHES = 50;
    const skippedIds: string[] = [];
    let batches = 0;

    for (;;) {
      if (++batches > MAX_BATCHES) {
        this.logger.warn(
          `Watched push for ${userId} hit the ${MAX_BATCHES}-batch ceiling — stopping. ` +
            `Some watches remain unsynced; run the sync again.`,
        );
        break;
      }
      const unsynced = await this.prisma.mediaUserWatch.findMany({
        where: {
          userId,
          syncedAt: null,
          source: { not: 'trakt' },
          ...(skippedIds.length ? { id: { notIn: skippedIds } } : {}),
        },
        take: BATCH,
      });
      if (!unsynced.length) break;

      const movies: any[] = [];
      const episodes: any[] = [];
      const pushedIds: string[] = [];

      for (const w of unsynced) {
        const ids = identityIds(w);
        const watchedAt = w.watchedAt.toISOString();
        if (!hasAnyId(ids)) {
          // No id at all: it cannot be placed in someone's history without
          // guessing which show it belongs to.
          summary.skipped++;
          skippedIds.push(w.id);
          continue;
        }
        (w.mediaType === 'movie' ? movies : episodes).push({ ids, watched_at: watchedAt });
        pushedIds.push(w.id);
      }

      if (pushedIds.length) {
        await client.post('/sync/history', { movies, episodes }, token);
        await this.prisma.mediaUserWatch.updateMany({
          where: { id: { in: pushedIds } },
          data: { syncedAt: new Date() },
        });
        summary.pushed += pushedIds.length;
      }
      // Nothing pushable in this batch and everything in it was skipped: the
      // remaining rows are all unidentifiable, so stop rather than spin.
      if (!pushedIds.length && unsynced.length < BATCH) break;
    }

    await this.prisma.traktAccount.update({
      where: { userId },
      data: { lastWatchedSyncAt: new Date() },
    });
    await this.audit.record({
      userId: ctx.userId ?? userId,
      action: 'media.trakt.watched_synced',
      objectType: 'trakt_account',
      objectId: userId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { ...summary },
    });
    return summary;
  }

  /** Trakt's history/ratings entries share a shape: {type, movie|show|episode}. */
  private identityFromTraktEntry(entry: any): ItemIdentity | null {
    const type = entry?.type;
    if (type === 'movie' && entry.movie) {
      return {
        imdbId: entry.movie.ids?.imdb ?? null,
        tmdbId: entry.movie.ids?.tmdb ? String(entry.movie.ids.tmdb) : null,
        title: entry.movie.title ?? null,
        year: entry.movie.year ?? null,
      };
    }
    if (type === 'episode' && entry.episode) {
      return {
        // The EPISODE's ids — that is what Trakt returns and what identifies it.
        imdbId: entry.episode.ids?.imdb ?? null,
        tmdbId: entry.episode.ids?.tmdb ? String(entry.episode.ids.tmdb) : null,
        tvdbId: entry.episode.ids?.tvdb ? String(entry.episode.ids.tvdb) : null,
        title: entry.episode.title ?? null,
        showTitle: entry.show?.title ?? null,
        year: entry.show?.year ?? null,
        season: entry.episode.season ?? null,
        episode: entry.episode.number ?? null,
      };
    }
    if (type === 'show' && entry.show) {
      return {
        imdbId: entry.show.ids?.imdb ?? null,
        tmdbId: entry.show.ids?.tmdb ? String(entry.show.ids.tmdb) : null,
        tvdbId: entry.show.ids?.tvdb ? String(entry.show.ids.tvdb) : null,
        title: entry.show.title ?? null,
        year: entry.show.year ?? null,
      };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Ratings — both directions
  // -------------------------------------------------------------------------

  async syncRatings(userId: string, ctx: AuditContext = {}): Promise<SyncSummary> {
    const token = await this.auth.accessTokenFor(userId);
    const client = await this.client();
    const summary: SyncSummary = { pulled: 0, pushed: 0, skipped: 0 };

    const { items: ratings } = await client.getAll<any>('/sync/ratings', token);
    for (const entry of ratings) {
      const identity = this.identityFromTraktEntry(entry);
      const rating = Number(entry?.rating);
      if (!identity || !Number.isInteger(rating)) {
        summary.skipped++;
        continue;
      }
      const key = watchKey(identity);
      await this.prisma.mediaUserRating.upsert({
        where: { userId_key: { userId, key } },
        create: {
          userId,
          key,
          mediaType: entry.type,
          imdbId: identity.imdbId ?? null,
          tmdbId: identity.tmdbId ?? null,
          tvdbId: identity.tvdbId ?? null,
          showTitle: identity.showTitle ?? null,
          title: identity.title ?? null,
          season: identity.season ?? null,
          episode: identity.episode ?? null,
          rating,
          ratedAt: new Date(entry.rated_at ?? Date.now()),
          source: 'trakt',
          syncedAt: new Date(),
        },
        // Trakt is authoritative for a rating THEY hold: the user set it there.
        update: { rating, ratedAt: new Date(entry.rated_at ?? Date.now()) },
      });
      summary.pulled++;
    }

    const unsynced = await this.prisma.mediaUserRating.findMany({
      where: { userId, syncedAt: null, source: { not: 'trakt' } },
      take: 1000,
    });
    const movies: any[] = [];
    const episodes: any[] = [];
    const shows: any[] = [];
    const pushedIds: string[] = [];

    for (const r of unsynced) {
      const ids = identityIds(r);
      if (!hasAnyId(ids)) {
        summary.skipped++;
        continue;
      }
      const payload = { ids, rating: r.rating, rated_at: r.ratedAt.toISOString() };
      if (r.mediaType === 'movie') movies.push(payload);
      else if (r.mediaType === 'episode') episodes.push(payload);
      else shows.push(payload);
      pushedIds.push(r.id);
    }

    if (movies.length || episodes.length || shows.length) {
      await client.post('/sync/ratings', { movies, shows, episodes }, token);
      await this.prisma.mediaUserRating.updateMany({
        where: { id: { in: pushedIds } },
        data: { syncedAt: new Date() },
      });
      summary.pushed = pushedIds.length;
    }

    await this.prisma.traktAccount.update({
      where: { userId },
      data: { lastRatingsSyncAt: new Date() },
    });
    await this.audit.record({
      userId: ctx.userId ?? userId,
      action: 'media.trakt.ratings_synced',
      objectType: 'trakt_account',
      objectId: userId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { ...summary },
    });
    return summary;
  }

  /**
   * Seed watched state from the media server's own history, for the Plex/Jellyfin
   * user this Trakt account is linked to.
   *
   * Without this, "sync watched" would only ever carry plays observed AFTER the
   * link was made — years of existing history would sit there, invisible to Trakt.
   * Only plays that actually finished (≥80%, Trakt's own threshold for "watched")
   * count; a two-minute sample is not a watch.
   */
  async backfillWatchesFromMediaServer(userId: string): Promise<{ imported: number; skipped: number }> {
    const account = await this.prisma.traktAccount.findUnique({ where: { userId } });
    if (!account?.mediaServerUserName) {
      throw new NotFoundException(
        'Link a media-server username to this Trakt account first — otherwise there is no way to tell whose plays these are.',
      );
    }

    const history = await this.prisma.mediaServerWatchHistory.findMany({
      where: {
        userName: account.mediaServerUserName,
        percentComplete: { gte: 80 },
      },
      orderBy: { startedAt: 'desc' },
      take: 5000,
    });

    let imported = 0;
    let skipped = 0;
    for (const play of history) {
      // The history row carries a joined "Show — Episode" display title and no
      // ids, so resolve identity through OUR library instead of guessing.
      const identity = await this.resolveIdentityFromTitle(play.title, play.mediaType);
      if (!identity) {
        skipped++;
        continue;
      }
      const key = watchKey(identity);
      const existing = await this.prisma.mediaUserWatch.findUnique({
        where: { userId_key: { userId, key } },
      });
      if (existing) {
        skipped++;
        continue;
      }
      await this.prisma.mediaUserWatch.create({
        data: {
          userId,
          key,
          mediaType: identity.season != null ? 'episode' : 'movie',
          imdbId: identity.imdbId ?? null,
          tmdbId: identity.tmdbId ?? null,
          tvdbId: identity.tvdbId ?? null,
          showTitle: identity.showTitle ?? null,
          title: identity.title ?? null,
          season: identity.season ?? null,
          episode: identity.episode ?? null,
          watchedAt: play.stoppedAt ?? play.startedAt,
          source: 'media_server',
        },
      });
      imported++;
    }
    return { imported, skipped };
  }

  /**
   * Resolve a media-server display title against our own library, so a play we
   * observed can be identified by id rather than by name. Null when the library
   * cannot place it — which is a skip, never a guess.
   */
  private async resolveIdentityFromTitle(
    title: string,
    mediaType: string | null,
  ): Promise<ItemIdentity | null> {
    // "Show — Episode" (the joined display string the session provider builds).
    const [showPart] = title.split(' — ');
    const item = await this.prisma.mediaItem.findFirst({
      where: { title: showPart?.trim() || title },
      select: {
        title: true,
        year: true,
        season: true,
        episode: true,
        mediaType: true,
        externalIds: { select: { provider: true, externalId: true } },
      },
    });
    if (!item) return null;
    const ids = Object.fromEntries(item.externalIds.map((x) => [x.provider, x.externalId]));
    return {
      imdbId: ids.imdb ?? null,
      tmdbId: ids.tmdb ?? null,
      tvdbId: ids.tvdb ?? null,
      title: item.title,
      showTitle: item.mediaType === 'movie' ? null : item.title,
      year: item.year,
      season: mediaType === 'movie' ? null : item.season,
      episode: mediaType === 'movie' ? null : item.episode,
    };
  }
}
