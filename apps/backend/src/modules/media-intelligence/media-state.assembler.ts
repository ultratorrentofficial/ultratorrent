import { Injectable, Logger } from '@nestjs/common';
import {
  canonicalLanguage,
  type MediaIntelligenceEntityType,
  type UnifiedMediaState,
} from '@ultratorrent/shared';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MediaLinkageService } from '../media/media-linkage.service';
import { MissingEpisodesService } from '../media-acquisition/missing-episodes.service';
import { scoreItem, type HealthFacts } from '../media/health/media-health-score';
import type { EvaluationInput } from './media-health-evaluator';
import { QualityPreferenceResolver } from './quality/preference-resolution.service';
import { representativeQuality } from './quality/owned-quality';
import { aggregateQuality, evaluateQualityCompliance } from './quality/quality-evaluator';

/**
 * Gathers the facts Media Intelligence reasons over — and owns none of them.
 *
 * Every read here targets a table another module is authoritative for, and the
 * assembler's whole job is to ask those domains what they already know and
 * normalise the answers into one shape. It computes no media truth of its own.
 *
 * Four rules are enforced by construction rather than by care:
 *
 * 1. **Nothing is triggered.** No mediainfo probe, no metadata provider call,
 *    no indexer search, no library scan, no media-server refresh. Opening the
 *    Intelligence page must cost queries and nothing else, so this file reads
 *    stored columns exclusively — `techSource === 'probe'` for measurement,
 *    never `MediaProbeService`.
 * 2. **Watch history is never touched.** Every `media_server_watch_history` row
 *    carries an IP address, a device and a viewer name. The only playback source
 *    used here is the derived `MediaPlaybackAggregate`, which is aggregate-only
 *    and holds no personal data at all.
 * 3. **UNKNOWN is preserved.** A missing aggregate, an unprobed file or an
 *    unlinkable torrent produces `status: 'unknown'` with a reason — never a
 *    zero that reads as a measurement.
 * 4. **Queries are bounded.** Series facts are gathered with grouped queries
 *    over the show's episodes, not a walk per episode; the missing-episode
 *    rollup reuses Missing Episodes' own `groupBy` summary rather than
 *    re-counting `wanted_episodes`.
 */
@Injectable()
export class MediaStateAssembler {
  private readonly logger = new Logger(MediaStateAssembler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly linkage: MediaLinkageService,
    private readonly missingEpisodes: MissingEpisodesService,
    private readonly preferences: QualityPreferenceResolver,
  ) {}

  /** Assemble the fact half of a unified state. Health is decided downstream. */
  async assemble(
    entityType: MediaIntelligenceEntityType,
    entityId: string,
    opts: { includePaths: boolean } = { includePaths: false },
  ): Promise<{ facts: EvaluationInput['facts']; hygieneScore: number | null } | null> {
    switch (entityType) {
      case 'movie':
      case 'episode':
        return this.assembleItem(entityType, entityId, opts);
      case 'series':
        return this.assembleSeries(entityId, opts);
      case 'season':
        return this.assembleSeason(entityId, opts);
      default:
        return null;
    }
  }

  /* ------------------------------------------------------------- one item */

  private async assembleItem(
    entityType: 'movie' | 'episode',
    itemId: string,
    opts: { includePaths: boolean },
  ): Promise<{ facts: EvaluationInput['facts']; hygieneScore: number | null } | null> {
    const item = await this.prisma.mediaItem.findUnique({
      where: { id: itemId },
      include: {
        files: { select: FILE_SELECT },
        metadata: true,
        artwork: { select: { type: true } },
        subtitles: { select: { language: true } },
        externalIds: { select: { provider: true, externalId: true } },
        nfoFiles: { select: { id: true } },
        library: { select: { id: true, name: true, kind: true, lastScanAt: true } },
        playbackAggregate: true,
      },
    });
    if (!item) return null;

    const now = new Date().toISOString();
    const files = item.files ?? [];
    const externalIds = Object.fromEntries(item.externalIds.map((e) => [e.provider, e.externalId]));

    // Two library rows wearing the same external id is evidence of a mis-tag,
    // never a licence to merge them. Bounded: one count query per provider id.
    const conflicting = await this.hasExternalIdConflict(item.id, item.externalIds);

    const technical = this.technicalFromFiles(files, now);
    const subtitleLangs = await this.subtitleLanguages(item.id, item.subtitles);
    const duplicates = await this.duplicateFacts(item.duplicateGroupId);
    const intake = await this.intakeFactsForItems([item.id], now);
    const torrent = await this.torrentFactsForItems([item.id], now);
    const usage = this.usageFromAggregate(item.playbackAggregate, now, false);

    const artworkTypes = [...new Set(item.artwork.map((a) => a.type))];
    const totalBytes = files.reduce((sum, f) => sum + Number(f.size ?? 0), 0);

    const hygiene = scoreItem({
      matched: item.matchStatus !== 'unmatched',
      hasMetadata: Boolean(item.metadata?.providerName),
      hasArtwork: artworkTypes.length > 0,
      hasSubtitles: subtitleLangs.length > 0,
      isDuplicate: item.duplicateGroupId != null,
      hasMeasuredTech: (technical.measuredFileCount ?? 0) > 0,
      unorganised: false,
    } satisfies HealthFacts);

    // One ladder read per entity; the global ladder short-circuits the rest.
    const globalLadder = await this.preferences.globalLadder();
    const ladder = await this.preferences.ladderFor(
      { imdbId: item.seriesImdbId ?? externalIds.imdb ?? null },
      globalLadder,
    );
    const rep = representativeQuality(files);
    const quality = {
      owned: rep.quality,
      ladder,
      compliance: evaluateQualityCompliance(rep.quality, ladder),
      aggregate: null,
      measuredFileCount: rep.measuredCount,
      totalFileCount: rep.totalCount,
    };

    const facts = {
      entityType,
      entityId: item.id,
      identity: {
        status: 'known' as const,
        source: 'media_manager',
        observedAt: item.updatedAt.toISOString(),
        title: item.title,
        normalizedTitle: null,
        year: item.year,
        seasonNumber: item.season,
        episodeNumber: item.episode,
        episodeTitle: entityType === 'episode' ? item.title : null,
        externalIds,
        matchStatus: item.matchStatus,
        // A scanner-created row carries a real 0 it never scored. Only a row
        // that was actually matched can claim a confidence.
        confidence: item.matchStatus === 'unmatched' ? null : item.confidence,
        conflictingExternalIds: conflicting,
      },
      library: {
        status: 'known' as const,
        source: 'media_manager',
        observedAt: item.library?.lastScanAt?.toISOString() ?? null,
        present: true,
        libraryId: item.library?.id ?? null,
        libraryName: item.library?.name ?? null,
        libraryKind: item.library?.kind ?? null,
        // Withheld unless the caller may see raw storage paths.
        path: opts.includePaths ? item.path : null,
        fileCount: files.length,
        episodeCount: null,
        seasonCount: null,
        totalBytes,
        duplicateGroupCount: duplicates.groups,
        duplicateReclaimableBytes: duplicates.reclaimableBytes,
        lastScanAt: item.library?.lastScanAt?.toISOString() ?? null,
      },
      // Episode-level completeness is a series question; a movie has none.
      completeness: this.notApplicableCompleteness(),
      technical,
      metadata: {
        status: item.metadata ? ('known' as const) : ('unknown' as const),
        source: 'media_manager',
        observedAt: item.metadata?.updatedAt?.toISOString() ?? null,
        ...(item.metadata ? {} : { unknownReason: 'no_aggregate' as const }),
        provider: item.metadata?.providerName ?? null,
        hasOverview: item.metadata ? Boolean(item.metadata.overview) : null,
        hasGenres: item.metadata ? Array.isArray(item.metadata.genres) && (item.metadata.genres as unknown[]).length > 0 : null,
        year: item.metadata?.year ?? null,
        runtimeMinutes: item.metadata?.runtime ?? null,
        nfoPresent: item.nfoFiles.length > 0,
        updatedAt: item.metadata?.updatedAt?.toISOString() ?? null,
      },
      artwork: {
        status: 'known' as const,
        source: 'media_manager',
        observedAt: now,
        posterPresent: artworkTypes.includes('poster'),
        fanartPresent: artworkTypes.includes('fanart'),
        typesPresent: artworkTypes,
        missingRequiredCount: REQUIRED_ARTWORK.filter((t) => !artworkTypes.includes(t)).length,
      },
      subtitles: {
        status: 'known' as const,
        source: 'media_manager',
        observedAt: now,
        languages: subtitleLangs,
        itemsWithSubtitles: subtitleLangs.length > 0 ? 1 : 0,
        itemsTotal: 1,
        // Embedded tracks are not modelled anywhere in the schema.
        embeddedTracksKnown: false,
      },
      acquisition: await this.acquisitionFactsForSeries(item.seriesImdbId, now),
      quality,
      intake,
      torrent,
      usage,
      storage: {
        status: 'known' as const,
        source: 'media_manager',
        observedAt: now,
        totalBytes,
        fileCount: files.length,
        duplicateBytes: duplicates.reclaimableBytes,
        reclaimableBytes: duplicates.reclaimableBytes,
        storageProfileId: null,
        storageProfileName: null,
      },
    } as unknown as EvaluationInput['facts'];

    return { facts, hygieneScore: hygiene.score };
  }

  /* --------------------------------------------------------------- series */

  private async assembleSeries(
    showId: string,
    opts: { includePaths: boolean },
  ): Promise<{ facts: EvaluationInput['facts']; hygieneScore: number | null } | null> {
    const show = await this.prisma.mediaShow.findUnique({
      where: { id: showId },
      include: { library: { select: { id: true, name: true, kind: true, lastScanAt: true } }, metadata: true, artwork: { select: { type: true } } },
    });
    if (!show) return null;

    const now = new Date().toISOString();
    // No FK exists from an episode to its show, so the canonical link is the
    // show folder path prefix — the same join media-item.service.ts uses.
    const episodes = await this.prisma.mediaItem.findMany({
      where: { libraryId: show.libraryId, path: { startsWith: `${show.path}/` } },
      select: {
        id: true, title: true, season: true, episode: true, matchStatus: true, confidence: true,
        duplicateGroupId: true, updatedAt: true,
        files: { select: FILE_SELECT },
        metadata: { select: { providerName: true, updatedAt: true } },
        subtitles: { select: { language: true } },
        artwork: { select: { type: true } },
        playbackAggregate: true,
      },
    });

    const itemIds = episodes.map((e) => e.id);
    const allFiles = episodes.flatMap((e) => e.files);
    const technical = this.technicalFromFiles(allFiles, now);
    const totalBytes = allFiles.reduce((sum, f) => sum + Number(f.size ?? 0), 0);
    const seasons = new Set(episodes.map((e) => e.season).filter((s): s is number => s != null));

    const withSubs = episodes.filter((e) => e.subtitles.length > 0).length;
    const languages = [...new Set(episodes.flatMap((e) => e.subtitles.map((s) => canonicalLanguage(s.language))).filter(Boolean))];
    const duplicateGroups = new Set(episodes.map((e) => e.duplicateGroupId).filter((g): g is string => g != null));
    const dupes = await this.duplicateFactsForGroups([...duplicateGroups]);

    const artworkTypes = [...new Set(show.artwork.map((a) => a.type))];
    const completeness = await this.completenessForShow(show.imdbId, show.title, now);

    const scores = episodes.map((e) =>
      scoreItem({
        matched: e.matchStatus !== 'unmatched',
        hasMetadata: Boolean(e.metadata?.providerName),
        hasArtwork: e.artwork.length > 0,
        hasSubtitles: e.subtitles.length > 0,
        isDuplicate: e.duplicateGroupId != null,
        hasMeasuredTech: e.files.some((f) => f.techSource === 'probe'),
        unorganised: false,
      } satisfies HealthFacts).score,
    );
    const hygiene = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

    /*
     * Quality per EPISODE, then aggregated. A series is not one file, and
     * reporting the show's dominant profile as "the" quality would hide the
     * single 720p episode among sixty-one 1080p ones — the exact thing an
     * operator opens this page to find.
     */
    const globalLadder = await this.preferences.globalLadder();
    const ladder = await this.preferences.ladderFor(
      { showId: show.id, imdbId: show.imdbId },
      globalLadder,
    );
    const perEpisode = episodes.map((e) => {
      const rep = representativeQuality(e.files);
      return { owned: rep.quality, compliance: evaluateQualityCompliance(rep.quality, ladder) };
    });
    const showRep = representativeQuality(allFiles);
    const quality = {
      owned: showRep.quality,
      ladder,
      compliance: evaluateQualityCompliance(showRep.quality, ladder),
      aggregate: aggregateQuality(perEpisode),
      measuredFileCount: showRep.measuredCount,
      totalFileCount: showRep.totalCount,
    };

    const facts = {
      entityType: 'series' as const,
      entityId: show.id,
      identity: {
        status: 'known' as const,
        source: 'media_manager',
        observedAt: show.updatedAt.toISOString(),
        title: show.title,
        normalizedTitle: show.canonicalKey,
        year: show.year,
        seasonNumber: null,
        episodeNumber: null,
        episodeTitle: null,
        externalIds: {
          ...(show.imdbId ? { imdb: show.imdbId } : {}),
          ...(show.tmdbId ? { tmdb: show.tmdbId } : {}),
        },
        // A show row has no matchStatus of its own; it is identified by having
        // a provider id at all.
        matchStatus: show.imdbId || show.tmdbId ? 'matched' : 'unmatched',
        confidence: null,
        conflictingExternalIds: false,
      },
      library: {
        status: 'known' as const,
        source: 'media_manager',
        observedAt: show.library?.lastScanAt?.toISOString() ?? null,
        present: true,
        libraryId: show.library?.id ?? null,
        libraryName: show.library?.name ?? null,
        libraryKind: show.library?.kind ?? null,
        path: opts.includePaths ? show.path : null,
        fileCount: allFiles.length,
        episodeCount: episodes.length,
        seasonCount: seasons.size,
        totalBytes,
        duplicateGroupCount: dupes.groups,
        duplicateReclaimableBytes: dupes.reclaimableBytes,
        lastScanAt: show.library?.lastScanAt?.toISOString() ?? null,
      },
      completeness,
      technical,
      metadata: {
        status: show.metadata ? ('known' as const) : ('unknown' as const),
        source: 'media_manager',
        observedAt: show.metadata?.updatedAt?.toISOString() ?? null,
        ...(show.metadata ? {} : { unknownReason: 'no_aggregate' as const }),
        provider: show.metadata?.providerName ?? null,
        hasOverview: show.metadata ? Boolean(show.metadata.overview) : null,
        hasGenres: show.metadata ? Array.isArray(show.metadata.genres) && (show.metadata.genres as unknown[]).length > 0 : null,
        year: show.year,
        runtimeMinutes: null,
        nfoPresent: null,
        updatedAt: show.metadata?.updatedAt?.toISOString() ?? null,
      },
      artwork: {
        status: 'known' as const,
        source: 'media_manager',
        observedAt: now,
        posterPresent: artworkTypes.includes('poster'),
        fanartPresent: artworkTypes.includes('fanart'),
        typesPresent: artworkTypes,
        missingRequiredCount: REQUIRED_ARTWORK.filter((t) => !artworkTypes.includes(t)).length,
      },
      subtitles: {
        status: episodes.length ? ('known' as const) : ('unknown' as const),
        source: 'media_manager',
        observedAt: now,
        ...(episodes.length ? {} : { unknownReason: 'not_scanned' as const }),
        languages,
        itemsWithSubtitles: episodes.length ? withSubs : null,
        itemsTotal: episodes.length || null,
        embeddedTracksKnown: false,
      },
      acquisition: await this.acquisitionFactsForSeries(show.imdbId, now),
      quality,
      intake: await this.intakeFactsForItems(itemIds, now),
      torrent: await this.torrentFactsForItems(itemIds, now),
      usage: this.usageForEpisodes(episodes.map((e) => e.playbackAggregate), now),
      storage: {
        status: 'known' as const,
        source: 'media_manager',
        observedAt: now,
        totalBytes,
        fileCount: allFiles.length,
        duplicateBytes: dupes.reclaimableBytes,
        reclaimableBytes: dupes.reclaimableBytes,
        storageProfileId: null,
        storageProfileName: null,
      },
    } as unknown as EvaluationInput['facts'];

    return { facts, hygieneScore: hygiene };
  }

  /** A season is `showId:seasonNumber` — it owns no row of its own. */
  private async assembleSeason(
    compositeId: string,
    opts: { includePaths: boolean },
  ): Promise<{ facts: EvaluationInput['facts']; hygieneScore: number | null } | null> {
    const idx = compositeId.lastIndexOf(':');
    if (idx <= 0) return null;
    const showId = compositeId.slice(0, idx);
    const seasonNumber = Number(compositeId.slice(idx + 1));
    if (!Number.isInteger(seasonNumber)) return null;

    const base = await this.assembleSeries(showId, opts);
    if (!base) return null;

    // Narrow the series view to one season's completeness; the rest of the
    // sections are already show-scoped facts the season shares.
    const show = await this.prisma.mediaShow.findUnique({
      where: { id: showId },
      select: { imdbId: true, title: true, libraryId: true, path: true },
    });
    const seasons = show ? await this.seasonCompleteness(show.imdbId, seasonNumber) : null;

    /*
     * Quality is re-aggregated over THIS season's episodes.
     *
     * Inheriting the series block would report the show's spread — including
     * every other season's episodes — under a season's name. A season that is
     * uniformly 1080p must not be coloured by a 720p episode belonging to
     * season 1, and vice versa: the outlier has to stay attached to the
     * season that actually owns it.
     */
    const quality = show ? await this.seasonQuality(show, showId, seasonNumber) : null;

    const facts = {
      ...base.facts,
      entityType: 'season' as const,
      entityId: compositeId,
      ...(seasons ? { completeness: seasons } : {}),
      ...(quality ? { quality } : {}),
    } as unknown as EvaluationInput['facts'];
    return { facts, hygieneScore: base.hygieneScore };
  }

  /**
   * Quality for one season, aggregated over only that season's episodes.
   *
   * One query, narrowed by the same path-prefix join the series path uses,
   * plus the season number — never a fan-out per episode.
   */
  private async seasonQuality(
    show: { imdbId: string | null; libraryId: string; path: string },
    showId: string,
    seasonNumber: number,
  ) {
    const episodes = await this.prisma.mediaItem.findMany({
      where: { libraryId: show.libraryId, path: { startsWith: `${show.path}/` }, season: seasonNumber },
      select: { files: { select: FILE_SELECT } },
    });
    if (!episodes.length) return null;

    const globalLadder = await this.preferences.globalLadder();
    const ladder = await this.preferences.ladderFor({ showId, imdbId: show.imdbId }, globalLadder);

    const perEpisode = episodes.map((e) => {
      const rep = representativeQuality(e.files);
      return { owned: rep.quality, compliance: evaluateQualityCompliance(rep.quality, ladder) };
    });
    const seasonRep = representativeQuality(episodes.flatMap((e) => e.files));

    return {
      owned: seasonRep.quality,
      ladder,
      compliance: evaluateQualityCompliance(seasonRep.quality, ladder),
      aggregate: aggregateQuality(perEpisode),
      measuredFileCount: seasonRep.measuredCount,
      totalFileCount: seasonRep.totalCount,
    };
  }

  /* ----------------------------------------------------------- fact helpers */

  /**
   * Technical facts from stored columns only.
   *
   * `techSource === 'probe'` is the sole definition of measured. A filename
   * guess is reported separately as `declared` so Phase 2 can never mistake it
   * for measurement, and an unprobed file is counted as pending rather than
   * folded into a zero.
   */
  private technicalFromFiles(files: readonly StoredFile[], now: string) {
    const measured = files.filter((f) => f.techSource === 'probe');
    const unmeasurable = files.filter((f) => f.probeError != null);
    const unprobed = files.filter((f) => f.techSource !== 'probe' && f.probeError == null);

    const profiles = new Set(
      measured.map((f) => `${f.height ?? '?'}|${f.videoCodec ?? '?'}|${f.hdrFormat ?? '?'}|${f.audioCodec ?? '?'}`),
    );
    const rep = measured[0] ?? null;
    const declaredSource = files[0] ?? null;

    return {
      status: measured.length ? ('known' as const) : ('unknown' as const),
      source: 'media_manager',
      observedAt: rep?.probedAt?.toISOString() ?? null,
      ...(measured.length
        ? {}
        : { unknownReason: (unmeasurable.length ? 'probe_failed' : 'not_probed') as 'probe_failed' | 'not_probed' }),
      measuredFileCount: measured.length,
      unprobedFileCount: unprobed.length,
      unmeasurableFileCount: unmeasurable.length,
      profile: rep
        ? {
            width: rep.width, height: rep.height, resolution: rep.resolution, videoCodec: rep.videoCodec,
            bitrateKbps: rep.bitrateKbps, durationSec: rep.durationSec, frameRate: rep.frameRate,
            videoBitDepth: rep.videoBitDepth, hdrFormat: rep.hdrFormat, audioCodec: rep.audioCodec,
            audioChannels: rep.audioChannels, container: rep.container, sizeBytes: Number(rep.size ?? 0),
          }
        : null,
      distinctProfileCount: measured.length ? profiles.size : null,
      declared: declaredSource
        ? { resolution: declaredSource.resolution, videoCodec: declaredSource.videoCodec, hdr: declaredSource.hdr }
        : null,
      _now: now,
    };
  }

  /** Subtitle coverage spans two modules; the union is the honest answer. */
  private async subtitleLanguages(itemId: string, sidecars: readonly { language: string }[]): Promise<string[]> {
    const downloads = await this.prisma.subtitleDownload
      .findMany({ where: { itemId }, select: { language: true } })
      .catch(() => [] as { language: string }[]);
    const all = [...sidecars.map((s) => s.language), ...downloads.map((d) => d.language)];
    return [...new Set(all.map((l) => canonicalLanguage(l)).filter(Boolean))];
  }

  private async hasExternalIdConflict(
    itemId: string,
    ids: readonly { provider: string; externalId: string }[],
  ): Promise<boolean> {
    if (!ids.length) return false;
    const clash = await this.prisma.mediaExternalId.count({
      where: { OR: ids.map((i) => ({ provider: i.provider, externalId: i.externalId })), NOT: { itemId } },
    });
    return clash > 0;
  }

  private async duplicateFacts(groupId: string | null) {
    return this.duplicateFactsForGroups(groupId ? [groupId] : []);
  }

  private async duplicateFactsForGroups(groupIds: string[]) {
    if (!groupIds.length) return { groups: 0, reclaimableBytes: 0 };
    const rows = await this.prisma.mediaDuplicateGroup.findMany({
      where: { id: { in: groupIds }, status: 'open' },
      select: { potentialSavingsBytes: true },
    });
    return {
      groups: rows.length,
      reclaimableBytes: rows.reduce((s, r) => s + Number(r.potentialSavingsBytes ?? 0), 0),
    };
  }

  /**
   * Completeness, delegated wholesale to Missing Episodes.
   *
   * `listGrouped()` is already a bulk `groupBy` rollup, so reusing it keeps this
   * to three queries for the whole library instead of one per series — and
   * means the classification of missing vs unaired vs ignored has exactly one
   * implementation.
   */
  private async completenessForShow(imdbId: string | null, title: string, now: string) {
    if (!imdbId) {
      return {
        status: 'unknown' as const, source: 'media_acquisition', observedAt: null,
        unknownReason: 'no_mapping' as const,
        expected: null, owned: null, missing: null, unaired: null, ignored: null,
        excludedFromScope: null, completionPercent: null, showStatus: null,
      };
    }
    const summaries = await this.missingEpisodes.listGrouped().catch(() => []);
    const match = summaries.find((s) => s.seriesTconst === imdbId);
    if (!match) {
      return {
        status: 'unknown' as const, source: 'media_acquisition', observedAt: null,
        unknownReason: 'not_monitored' as const,
        expected: null, owned: null, missing: null, unaired: null, ignored: null,
        excludedFromScope: null, completionPercent: null, showStatus: null,
      };
    }
    const denominator = match.total - match.unaired - match.ignored;
    return {
      status: 'known' as const,
      source: 'media_acquisition',
      observedAt: match.lastCheckedAt ? new Date(match.lastCheckedAt).toISOString() : now,
      expected: match.total,
      owned: match.owned,
      missing: match.missing,
      unaired: match.unaired,
      ignored: match.ignored,
      excludedFromScope: null,
      completionPercent: denominator > 0 ? Math.round((match.owned / denominator) * 100) : null,
      showStatus: match.showStatus,
    };
  }

  private async seasonCompleteness(imdbId: string | null, seasonNumber: number) {
    if (!imdbId) return null;
    const item = await this.prisma.mediaAcquisitionWatchlistItem.findFirst({
      where: { externalIds: { path: ['imdb'], equals: imdbId } },
      select: { id: true },
    }).catch(() => null);
    if (!item) return null;
    const seasons = await this.missingEpisodes.listSeasons(item.id).catch(() => []);
    const s = seasons.find((x) => x.seasonNumber === seasonNumber);
    if (!s) return null;
    const denominator = s.total - s.unaired - s.ignored;
    return {
      status: 'known' as const,
      source: 'media_acquisition',
      observedAt: new Date().toISOString(),
      expected: s.total, owned: s.owned, missing: s.missing, unaired: s.unaired, ignored: s.ignored,
      excludedFromScope: null,
      completionPercent: denominator > 0 ? Math.round((s.owned / denominator) * 100) : null,
      showStatus: null,
    };
  }

  private notApplicableCompleteness() {
    return {
      status: 'unknown' as const,
      source: 'media_acquisition',
      observedAt: null,
      unknownReason: 'not_applicable' as const,
      expected: null, owned: null, missing: null, unaired: null, ignored: null,
      excludedFromScope: null, completionPercent: null, showStatus: null,
    };
  }

  /** Acquisition state, only for a series that is actually monitored. */
  private async acquisitionFactsForSeries(imdbId: string | null, now: string) {
    const unknown = {
      status: 'unknown' as const, source: 'media_acquisition', observedAt: null,
      unknownReason: 'not_monitored' as const,
      monitored: false, watchlistItemId: null, mode: null, watchlistStatus: null,
      ruleId: null, ruleEnabled: null, usesGlobalPreferences: null,
      searchesPending: null, searchesFailed: null, searchesNoResults: null,
      lastSearchAt: null, lastGrabAt: null, activeBackfillJobId: null,
    };
    if (!imdbId) return unknown;

    const item = await this.prisma.mediaAcquisitionWatchlistItem
      .findFirst({
        where: { externalIds: { path: ['imdb'], equals: imdbId } },
        select: { id: true, status: true, rssRuleId: true, settings: true },
      })
      .catch(() => null);
    if (!item) return unknown;

    const [byStatus, rule] = await Promise.all([
      this.prisma.wantedEpisode.groupBy({
        by: ['searchStatus'],
        where: { watchlistItemId: item.id },
        _count: { _all: true },
        _max: { lastSearchedAt: true, grabbedAt: true },
      }),
      item.rssRuleId
        ? this.prisma.rssRule.findUnique({ where: { id: item.rssRuleId }, select: { id: true, isEnabled: true } })
        : Promise.resolve(null),
    ]);

    const count = (s: string) => byStatus.find((r) => r.searchStatus === s)?._count._all ?? 0;
    const maxOf = (k: 'lastSearchedAt' | 'grabbedAt') =>
      byStatus.map((r) => r._max[k]).filter((d): d is Date => d != null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const settings = (item.settings ?? {}) as { seriesAcquisitionMode?: string };

    return {
      status: 'known' as const,
      source: 'media_acquisition',
      observedAt: now,
      monitored: item.status === 'active',
      watchlistItemId: item.id,
      mode: settings.seriesAcquisitionMode ?? null,
      watchlistStatus: item.status,
      ruleId: rule?.id ?? null,
      ruleEnabled: rule?.isEnabled ?? null,
      // A Backfill-Only add deliberately has no rule and grabs through the
      // global preference ladder — absence of a rule is by design, not a gap.
      usesGlobalPreferences: rule == null,
      searchesPending: count('idle') + count('searching'),
      searchesFailed: count('failed'),
      searchesNoResults: count('no_results'),
      lastSearchAt: maxOf('lastSearchedAt')?.toISOString() ?? null,
      lastGrabAt: maxOf('grabbedAt')?.toISOString() ?? null,
      activeBackfillJobId: null,
    };
  }

  /** Intake facts, grouped — never one query per item. */
  private async intakeFactsForItems(itemIds: readonly string[], now: string) {
    if (!itemIds.length) {
      return {
        status: 'unknown' as const, source: 'media_intake', observedAt: null,
        unknownReason: 'no_mapping' as const,
        total: null, active: null, imported: null, failed: null, quarantined: null,
        lastIntakeAt: null, lastError: null,
      };
    }
    const rows = await this.prisma.mediaIntakeJob.groupBy({
      by: ['state'],
      where: { mediaItemId: { in: [...itemIds] } },
      _count: { _all: true },
      _max: { updatedAt: true },
    });
    if (!rows.length) {
      // Nothing came through intake. That is normal for scanned media and is
      // genuinely "no association", not a failure.
      return {
        status: 'unknown' as const, source: 'media_intake', observedAt: null,
        unknownReason: 'no_mapping' as const,
        total: null, active: null, imported: null, failed: null, quarantined: null,
        lastIntakeAt: null, lastError: null,
      };
    }
    const n = (s: string) => rows.find((r) => r.state === s)?._count._all ?? 0;
    const total = rows.reduce((s, r) => s + r._count._all, 0);
    const failed = n('failed');
    const lastError = failed
      ? (
          await this.prisma.mediaIntakeJob.findFirst({
            where: { mediaItemId: { in: [...itemIds] }, state: 'failed' },
            orderBy: { updatedAt: 'desc' },
            select: { lastError: true },
          })
        )?.lastError ?? null
      : null;

    return {
      status: 'known' as const,
      source: 'media_intake',
      observedAt: rows.map((r) => r._max.updatedAt).filter((d): d is Date => d != null).sort((a, b) => b.getTime() - a.getTime())[0]?.toISOString() ?? now,
      total,
      active: total - n('imported') - failed - n('quarantined') - n('cancelled') - n('archived'),
      imported: n('imported') + n('archived') + n('seeding'),
      failed,
      quarantined: n('quarantined'),
      lastIntakeAt: rows.map((r) => r._max.updatedAt).filter((d): d is Date => d != null).sort((a, b) => b.getTime() - a.getTime())[0]?.toISOString() ?? null,
      lastError,
    };
  }

  /**
   * Torrent facts.
   *
   * The only honest bridge is an intake job carrying both a media item and a
   * hash, so media scanned from disk has no association — UNKNOWN, not "not
   * seeding". Live seeding state comes from the engine, and when the engine
   * cannot be reached `seedingItemIdsStrict` returns null, which stays unknown
   * rather than collapsing to zero.
   */
  private async torrentFactsForItems(itemIds: readonly string[], now: string) {
    const unknown = {
      status: 'unknown' as const, source: 'torrents', observedAt: null,
      unknownReason: 'no_torrent_link' as const,
      associatedCount: null, seedingCount: null, erroredCount: null,
      linkedItemCount: null, consideredItemCount: itemIds.length || null,
    };
    if (!itemIds.length) return unknown;

    const linked = await this.linkage.torrentsForItems(itemIds).catch(() => [] as Awaited<ReturnType<MediaLinkageService['torrentsForItems']>>);
    if (!linked.length) return unknown;

    const seeding = await this.linkage.seedingItemIdsStrict(itemIds).catch(() => null);
    const linkedItems = new Set(linked.flatMap((l) => l.itemIds));

    return {
      status: seeding === null ? ('partial' as const) : ('known' as const),
      source: 'torrents',
      observedAt: now,
      ...(seeding === null ? { unknownReason: 'engine_unreachable' as const } : {}),
      associatedCount: linked.length,
      seedingCount: seeding === null ? null : seeding.size,
      // Only the engine can report an error state; the intake job's own column
      // is written once and never revisited, so it is not evidence.
      erroredCount: null,
      linkedItemCount: linkedItems.size,
      consideredItemCount: itemIds.length,
    };
  }

  /** Movie/episode usage, straight from the derived aggregate. */
  private usageFromAggregate(agg: PlaybackAggregate | null, now: string, approximate: boolean) {
    if (!agg) {
      return {
        status: 'unknown' as const, source: 'media_server_analytics', observedAt: null,
        unknownReason: 'no_aggregate' as const,
        playCount: null, completedPlayCount: null, uniqueViewerCount: null,
        lastPlayedAt: null, totalPlaybackSeconds: null, approximate: true,
      };
    }
    return {
      status: 'known' as const,
      source: 'media_server_analytics',
      observedAt: agg.computedAt.toISOString(),
      playCount: agg.startedPlayCount,
      completedPlayCount: agg.completedPlayCount,
      uniqueViewerCount: agg.uniqueViewerCount,
      lastPlayedAt: agg.lastPlayedAt?.toISOString() ?? null,
      totalPlaybackSeconds: Number(agg.totalPlaybackSeconds ?? 0),
      approximate,
      _now: now,
    };
  }

  /**
   * Series usage — MAX across episodes, never SUM.
   *
   * The playback aggregate resolves history by title, and a show's total is
   * attributed to *each* of its episodes. Summing would turn a 23-play series
   * into hundreds. Taking the maximum recovers the show-level figure that was
   * distributed, and the result is flagged approximate because the underlying
   * join is a name match with no id anywhere.
   */
  private usageForEpisodes(aggs: readonly (PlaybackAggregate | null)[], now: string) {
    const present = aggs.filter((a): a is PlaybackAggregate => a != null);
    if (!present.length) {
      return {
        status: 'unknown' as const, source: 'media_server_analytics', observedAt: null,
        unknownReason: 'no_aggregate' as const,
        playCount: null, completedPlayCount: null, uniqueViewerCount: null,
        lastPlayedAt: null, totalPlaybackSeconds: null, approximate: true,
      };
    }
    const max = (pick: (a: PlaybackAggregate) => number) => Math.max(...present.map(pick));
    const lastPlayed = present
      .map((a) => a.lastPlayedAt)
      .filter((d): d is Date => d != null)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    return {
      status: 'known' as const,
      source: 'media_server_analytics',
      observedAt: present.map((a) => a.computedAt).sort((a, b) => b.getTime() - a.getTime())[0].toISOString(),
      playCount: max((a) => a.startedPlayCount),
      completedPlayCount: max((a) => a.completedPlayCount),
      uniqueViewerCount: max((a) => a.uniqueViewerCount),
      lastPlayedAt: lastPlayed?.toISOString() ?? null,
      totalPlaybackSeconds: max((a) => Number(a.totalPlaybackSeconds ?? 0)),
      approximate: true,
      _now: now,
    };
  }
}

/** Baseline artwork, matching the Media Manager's own definition. */
const REQUIRED_ARTWORK = ['poster', 'fanart'] as const;

/**
 * The stored technical projection.
 *
 * Mirrors `cleanup/candidate-discovery.service.ts`'s FILE_SELECT so both read
 * the same columns — and so neither can accidentally reach for a probe.
 */
const FILE_SELECT = {
  id: true, size: true, container: true, videoCodec: true, audioCodec: true, resolution: true,
  hdr: true, width: true, height: true, bitrateKbps: true, durationSec: true, audioChannels: true,
  frameRate: true, videoBitDepth: true, hdrFormat: true, techSource: true, probedAt: true, probeError: true,
} as const;

interface StoredFile {
  size: bigint | number | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  hdr: string | null;
  width: number | null;
  height: number | null;
  bitrateKbps: number | null;
  durationSec: number | null;
  audioChannels: number | null;
  frameRate: number | null;
  videoBitDepth: number | null;
  hdrFormat: string | null;
  techSource: string | null;
  probedAt: Date | null;
  probeError: string | null;
}

interface PlaybackAggregate {
  startedPlayCount: number;
  completedPlayCount: number;
  uniqueViewerCount: number;
  lastPlayedAt: Date | null;
  totalPlaybackSeconds: bigint | number | null;
  computedAt: Date;
}
