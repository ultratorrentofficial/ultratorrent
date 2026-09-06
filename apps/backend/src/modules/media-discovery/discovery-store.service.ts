import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ID_PRIORITY, type MergedDiscovery } from './discovery-identity';

/** What one persist pass did, for the sync log and the provider counters. */
export interface StoreResult {
  created: number;
  updated: number;
  failed: number;
}

/**
 * Persisting merged discoveries.
 *
 * The whole difficulty is one property of the merge: **the canonical key moves as
 * ids accumulate.** A TVmaze-only show is keyed `tvmaze:1234`; the week TMDB
 * starts reporting it with an IMDb id the same show keys `imdb:tt…`. Looking a
 * record up by its canonical key alone would find nothing and insert a second row
 * for a show already stored — and the two would then drift, each collecting half
 * the providers.
 *
 * So resolution is by ANY identity the record has ever answered to: its
 * `alternateKeys` against the stored `dedupeKey`, AND every external id against
 * the stored `externalIds`. The second half is what catches the case the first
 * cannot — a stored row keyed `imdb:tt5` when the incoming record knows only
 * `tvmaze:1234`, which is precisely the direction the key moves in.
 */
@Injectable()
export class DiscoveryStoreService {
  private readonly logger = new Logger(DiscoveryStoreService.name);

  constructor(private readonly prisma: PrismaService) {}

  async persist(records: MergedDiscovery[]): Promise<StoreResult> {
    const result: StoreResult = { created: 0, updated: 0, failed: 0 };
    for (const record of records) {
      try {
        const existing = await this.findExisting(record);
        if (existing) {
          await this.update(existing.id, existing, record);
          result.updated += 1;
        } else {
          await this.create(record);
          result.created += 1;
        }
      } catch (err) {
        // One bad record must not abandon the rest of a sync.
        result.failed += 1;
        this.logger.warn(`Discovery persist failed for "${record.title}": ${(err as Error).message}`);
      }
    }
    return result;
  }

  /** Any stored row this record is the same work as. */
  private async findExisting(record: MergedDiscovery) {
    const idFilters: Prisma.DiscoveredMediaWhereInput[] = ID_PRIORITY.filter(
      (ns) => record.externalIds[ns],
    ).map((ns) => ({
      externalIds: { path: [ns], equals: String(record.externalIds[ns]) },
    }));

    const keys = record.alternateKeys.length ? record.alternateKeys : [record.dedupeKey];
    return this.prisma.discoveredMedia.findFirst({
      where: {
        mediaType: record.mediaType,
        OR: [{ dedupeKey: { in: keys } }, ...idFilters],
      },
      select: { id: true, externalIds: true, sourceProviders: true, firstSeenAt: true, discoveryStatus: true },
    });
  }

  private async create(record: MergedDiscovery) {
    const now = new Date();
    const created = await this.prisma.discoveredMedia.create({
      data: {
        ...this.columns(record),
        dedupeKey: record.dedupeKey,
        firstSeenAt: now,
        lastSeenAt: now,
        lastRefreshedAt: now,
      },
      select: { id: true },
    });
    await this.writeReleaseDates(created.id, record);
  }

  private async update(
    id: string,
    existing: { externalIds: unknown; sourceProviders: string[] },
    record: MergedDiscovery,
  ) {
    /*
     * Ids and providers ACCUMULATE; they are never replaced.
     *
     * A sync where only TVmaze answered must not erase the TMDB id a previous
     * sync learned — a provider being quiet is not a provider retracting. The
     * stored value wins on a conflict, because an id already recorded has
     * survived at least one round of the identity gate.
     */
    const merged = { ...(record.externalIds as Record<string, string>) };
    for (const [ns, value] of Object.entries((existing.externalIds ?? {}) as Record<string, string>)) {
      if (value) merged[ns] = value;
    }
    const providers = [...new Set([...existing.sourceProviders, ...record.sourceProviders])];

    await this.prisma.discoveredMedia.update({
      where: { id },
      data: {
        ...this.columns(record),
        externalIds: merged as Prisma.InputJsonValue,
        sourceProviders: providers,
        lastSeenAt: new Date(),
        lastRefreshedAt: new Date(),
        /*
         * `dedupeKey` is deliberately NOT rewritten.
         *
         * The stored key is what other rows and any future reference resolve
         * against, and `alternateKeys` already makes a moved key findable. Chasing
         * the strongest id here would rename a row's identity mid-life for no gain
         * and risk colliding with the unique constraint against a different row.
         */
      },
    });
    await this.writeReleaseDates(id, record);
  }

  /** The provider-supplied columns, shared by create and update. */
  private columns(record: MergedDiscovery) {
    return {
      mediaType: record.mediaType,
      title: record.title,
      originalTitle: record.originalTitle,
      normalizedTitle: record.normalizedTitle,
      year: record.year,
      externalIds: record.externalIds as Prisma.InputJsonValue,
      genres: record.genres,
      originalLanguage: record.originalLanguage,
      countries: record.countries,
      network: record.network,
      studio: record.studio,
      streamingService: record.streamingService,
      overview: record.overview,
      posterUrl: record.posterUrl,
      backdropUrl: record.backdropUrl,
      popularity: record.popularity,
      rating: record.rating,
      voteCount: record.voteCount,
      seriesStatus: record.seriesStatus,
      seasonNumber: record.seasonNumber,
      episodeNumber: record.episodeNumber,
      premiereDate: record.premiereDate ? new Date(record.premiereDate) : null,
      seasonPremiereDate: record.seasonPremiereDate ? new Date(record.seasonPremiereDate) : null,
      sourceProviders: record.sourceProviders,
      confidence: record.confidence,
      identityStatus: record.identityStatus,
    };
  }

  /**
   * One row per (type, region, source), upserted.
   *
   * Upserted rather than replaced so a provider that goes quiet does not delete
   * the date it gave last week — the same reason ids accumulate. A date that has
   * genuinely moved is a change to that provider's own row, which is exactly what
   * the unique constraint makes it.
   */
  private async writeReleaseDates(discoveredMediaId: string, record: MergedDiscovery) {
    for (const d of record.releaseDates) {
      const region = d.region ?? null;
      const data = { date: d.date ? new Date(d.date) : null, confidence: d.confidence ?? 0 };

      /*
       * Read-then-write rather than `upsert`, because of `region`.
       *
       * Postgres treats NULLs as DISTINCT in a unique constraint, so
       * `(media, type, NULL, source)` never collides with itself: a provider that
       * gives a date with no region — most of TVmaze — would insert a fresh row on
       * every sync and the table would grow without bound. The composite unique
       * still protects the region-bearing rows; this covers the hole it leaves.
       */
      const existing = await this.prisma.discoveredMediaReleaseDate.findFirst({
        where: { discoveredMediaId, releaseType: d.releaseType, region, source: d.source },
        select: { id: true },
      });
      if (existing) {
        await this.prisma.discoveredMediaReleaseDate.update({ where: { id: existing.id }, data });
      } else {
        await this.prisma.discoveredMediaReleaseDate.create({
          data: { discoveredMediaId, releaseType: d.releaseType, region, source: d.source, ...data },
        });
      }
    }
  }
}
