/**
 * Subtitle Intelligence orchestration facade — the service the controller calls.
 *
 * Ties the pieces together: fingerprint → progressive multi-provider search →
 * score → (on download) validate → install a media-server-correct sidecar → record
 * everything (download, validation, history), surface it to media_manager, emit a
 * realtime + Notification-Center event, and audit. Pure logic (scoring, search
 * planning, validation, naming) lives in sibling modules; this coordinates IO.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NOTIFICATION_BUS_CHANNEL,
  NOTIFICATION_EVENTS,
  WS_EVENTS,
} from '@ultratorrent/shared';
import { Prisma, type SubtitleFingerprint } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AuditService, type AuditEntry } from '../audit/audit.service';
import { SubtitleProviderRegistry, PROVIDER_CATALOG } from './providers/provider-registry.service';
import {
  SubtitleProviderSettingsService,
  type ProviderConfigPatch,
} from './providers/subtitle-provider-settings.service';
import type { NormalizedSubtitle, SubtitleProvider, SubtitleSearchQuery } from './providers/subtitle-provider';
import { VideoFingerprintService } from './fingerprint/video-fingerprint.service';
import { SubtitleInstallService } from './pipeline/subtitle-install.service';
import { buildSearchLevels, levelAllowsAutoAccept, type SearchLevel } from './search/search-strategy';
import { scoreCandidate, type ScoringContext } from './search/scoring';
import { validateSubtitle } from './validation/subtitle-validator';
import { runtimeCrossCheck } from './validation/runtime-check';
import { SubtitleTriggerService } from './automation/subtitle-trigger.service';
import { SubtitleSettingsService } from './settings/subtitle-settings.service';

type AuditCtx = Pick<AuditEntry, 'userId' | 'ipAddress' | 'userAgent'>;

export interface SearchOptions {
  languages?: string[];
  hearingImpaired?: boolean;
  forced?: boolean;
}

@Injectable()
export class SubtitleService {
  private readonly logger = new Logger(SubtitleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SubtitleProviderRegistry,
    private readonly providerSettings: SubtitleProviderSettingsService,
    private readonly fingerprints: VideoFingerprintService,
    private readonly install: SubtitleInstallService,
    private readonly realtime: RealtimeGateway,
    private readonly audit: AuditService,
    private readonly eventBus: EventEmitter2,
    private readonly triggers: SubtitleTriggerService,
    private readonly globalSettings: SubtitleSettingsService,
  ) {}

  // --- providers ----------------------------------------------------------

  /** The provider catalog merged with stored (redacted) config + health. */
  async listProviders() {
    const stored = await this.providerSettings.list();
    const byKey = new Map(stored.map((s) => [s.provider, s]));
    return PROVIDER_CATALOG.map((c) => ({
      ...c,
      config: byKey.get(c.key) ?? null,
    }));
  }

  async upsertProvider(provider: string, patch: ProviderConfigPatch, ctx: AuditCtx) {
    if (!PROVIDER_CATALOG.some((c) => c.key === provider)) {
      throw new NotFoundException(`Unknown provider "${provider}"`);
    }
    const row = await this.providerSettings.upsert(provider, patch);
    await this.record(ctx, 'subtitle.provider.configured', 'subtitle_provider', provider, {
      isEnabled: patch.isEnabled,
      priority: patch.priority,
    });
    return row;
  }

  /** Health-check every enabled provider now, persisting each result. */
  async healthCheckAll(ctx: AuditCtx) {
    const providers = await this.registry.build();
    const results: Array<{ provider: string; healthy: boolean; message?: string }> = [];
    for (const p of providers) {
      const health = await p.healthCheck();
      await this.providerSettings.recordHealth(p.name, health);
      results.push({ provider: p.name, healthy: health.healthy, message: health.message });
    }
    await this.record(ctx, 'subtitle.providers.health_checked', 'subtitle_provider', 'all', { count: results.length });
    return results;
  }

  /** Test a provider's connectivity + credentials; persist the health result. */
  async testProvider(provider: string, ctx: AuditCtx) {
    const impl = await this.registry.get(provider);
    if (!impl) {
      await this.providerSettings.recordHealth(provider, { healthy: false, message: 'not implemented / not configured' });
      return { healthy: false, message: 'Provider is not implemented or not configured.' };
    }
    const health = await impl.healthCheck();
    await this.providerSettings.recordHealth(provider, health);
    await this.record(ctx, 'subtitle.provider.tested', 'subtitle_provider', provider, {
      healthy: health.healthy,
    }, health.healthy ? 'success' : 'failure');
    return health;
  }

  // --- language settings --------------------------------------------------

  async getLanguageSettings(libraryId: string) {
    const row = await this.prisma.subtitleLanguageSetting.findUnique({ where: { libraryId } });
    if (row) return row;
    // No explicit policy → fall back to the install-wide default languages.
    const { defaultLanguages } = await this.globalSettings.read();
    return this.defaultLanguageSetting(libraryId, defaultLanguages);
  }

  async setLanguageSettings(libraryId: string, patch: Record<string, unknown>, ctx: AuditCtx) {
    const data = {
      requiredLanguages: patch.requiredLanguages ?? [],
      preferredLanguages: patch.preferredLanguages ?? [],
      forcedLanguages: patch.forcedLanguages ?? [],
      hearingImpaired: !!patch.hearingImpaired,
      machineTranslation: !!patch.machineTranslation,
      preferredProviders: patch.preferredProviders ?? [],
      synchronizationRequired: !!patch.synchronizationRequired,
      minimumScore: typeof patch.minimumScore === 'number' ? patch.minimumScore : 50,
      automaticReplacement: !!patch.automaticReplacement,
    };
    const row = await this.prisma.subtitleLanguageSetting.upsert({
      where: { libraryId },
      create: { libraryId, ...(data as object) },
      update: data as object,
    });
    await this.record(ctx, 'subtitle.language_settings.updated', 'media_library', libraryId, {});
    return row;
  }

  private defaultLanguageSetting(libraryId: string, defaultLanguages: string[] = ['en']) {
    return {
      libraryId,
      requiredLanguages: [] as string[],
      preferredLanguages: defaultLanguages,
      forcedLanguages: [] as string[],
      hearingImpaired: false,
      machineTranslation: false,
      preferredProviders: [] as string[],
      synchronizationRequired: false,
      minimumScore: 50,
      automaticReplacement: false,
    };
  }

  // --- fingerprint --------------------------------------------------------

  fingerprint(itemId: string): Promise<SubtitleFingerprint> {
    return this.fingerprints.fingerprint(itemId);
  }

  // --- search -------------------------------------------------------------

  private capableAtLevel(p: SubtitleProvider, level: SearchLevel['level']): boolean {
    switch (level) {
      case 1: return p.supportsHashSearch();
      case 2: return p.supportsReleaseSearch();
      case 3: return p.supportsImdbSearch() || p.supportsTmdbSearch() || p.supportsTvdbSearch();
      case 4: return true; // title search is the universal fallback
    }
  }

  private async scoringContext(fp: SubtitleFingerprint, prefs: { preferredLanguages: string[]; preferredProviders: string[]; forced: boolean }): Promise<ScoringContext> {
    return {
      movieHash: fp.movieHash,
      fileSize: Number(fp.fileSize),
      imdbId: fp.imdbId,
      tmdbId: fp.tmdbId,
      tvdbId: fp.tvdbId,
      season: fp.season,
      episode: fp.episode,
      releaseGroup: fp.releaseGroup,
      source: fp.source,
      resolution: fp.resolution,
      runtimeSec: fp.runtimeSec,
      edition: fp.edition,
      preferredLanguages: prefs.preferredLanguages,
      preferredProviders: prefs.preferredProviders,
      forcedRequested: prefs.forced,
    };
  }

  /**
   * Search every enabled provider across progressive levels, score the results,
   * persist them, and return them best-first. Stops relaxing once a level yields
   * an auto-tier candidate (a hash match ends the search immediately).
   */
  async search(itemId: string, opts: SearchOptions, ctx: AuditCtx) {
    const item = await this.prisma.mediaItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Item not found');

    const langSettings = await this.getLanguageSettings(item.libraryId);
    const languages =
      opts.languages?.length
        ? opts.languages
        : [...new Set([...(langSettings.requiredLanguages as string[]), ...(langSettings.preferredLanguages as string[])])];
    const wantLanguages = languages.length ? languages : ['en'];

    const fp = await this.fingerprints.fingerprint(itemId);
    const providers = await this.registry.build();
    if (providers.length === 0) {
      return { candidates: [], warning: 'No subtitle providers are enabled. Configure one under Providers.' };
    }

    const query: SubtitleSearchQuery = {
      languages: wantLanguages,
      movieHash: fp.movieHash,
      fileSize: fp.fileSize ? Number(fp.fileSize) : null,
      releaseName: fp.releaseGroup ? `${item.title} ${fp.releaseGroup}` : item.title,
      releaseGroup: fp.releaseGroup,
      title: item.title,
      year: item.year,
      season: fp.season,
      episode: fp.episode,
      imdbId: fp.imdbId,
      tmdbId: fp.tmdbId,
      tvdbId: fp.tvdbId,
      runtimeSec: fp.runtimeSec,
      mediaType: (fp.mediaType as SubtitleSearchQuery['mediaType']) ?? null,
      hearingImpaired: opts.hearingImpaired ?? (langSettings.hearingImpaired as boolean),
      forced: opts.forced ?? false,
    };

    const scoreCtx = await this.scoringContext(fp, {
      preferredLanguages: langSettings.preferredLanguages as string[],
      preferredProviders: langSettings.preferredProviders as string[],
      forced: !!query.forced,
    });

    const levels = buildSearchLevels(query);
    const collected = new Map<string, NormalizedSubtitle & { matchLevel: number }>();

    for (const level of levels) {
      for (const provider of providers) {
        if (!this.capableAtLevel(provider, level.level)) continue;
        const results = await provider.search(level.query);
        for (const r of results) {
          // A provider-reported hash match (level 1) always wins over the query level.
          const matchLevel = r.matchLevel === 1 ? 1 : level.level;
          const key = `${r.provider}:${r.providerFileId ?? r.downloadUrl ?? r.filename}:${r.language}`;
          if (!collected.has(key)) collected.set(key, { ...r, matchLevel });
        }
      }
      // Early exit: if this level already produced an auto-tier candidate, stop relaxing.
      const strong = [...collected.values()].some((c) => scoreCandidate(c, scoreCtx).score >= 90);
      if (strong && level.level <= 3) break;
    }

    const scored = [...collected.values()]
      .map((sub) => {
        const s = scoreCandidate(sub, scoreCtx);
        return { sub, ...s };
      })
      .sort((a, b) => b.score - a.score);

    // Persist candidates (replace the item's prior set).
    await this.prisma.subtitleCandidate.deleteMany({ where: { itemId } });
    if (scored.length) {
      await this.prisma.subtitleCandidate.createMany({
        data: scored.map(({ sub, score, tier, breakdown }) => ({
          itemId,
          provider: sub.provider,
          providerFileId: sub.providerFileId ?? null,
          language: sub.language,
          releaseName: sub.releaseName ?? null,
          filename: sub.filename ?? null,
          movieHash: sub.movieHash ?? null,
          imdbId: sub.imdbId ?? null,
          tmdbId: sub.tmdbId ?? null,
          tvdbId: sub.tvdbId ?? null,
          season: sub.season ?? null,
          episode: sub.episode ?? null,
          runtimeSec: sub.runtimeSec ?? null,
          downloads: sub.downloads ?? null,
          uploader: sub.uploader ?? null,
          rating: sub.rating ?? null,
          trustedUploader: !!sub.trustedUploader,
          machineTranslated: !!sub.machineTranslated,
          hearingImpaired: !!sub.hearingImpaired,
          forced: !!sub.forced,
          fileSize: sub.fileSize != null ? BigInt(Math.trunc(sub.fileSize)) : null,
          downloadUrl: sub.downloadUrl ?? null,
          matchLevel: sub.matchLevel,
          score,
          scoreTier: tier,
          scoreBreakdown: breakdown as Prisma.InputJsonValue,
          rawMetadata: (sub.rawMetadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        })),
      });
    }

    await this.history(itemId, 'searched', { message: `${scored.length} candidate(s) across ${providers.length} provider(s)` });
    await this.record(ctx, 'subtitle.searched', 'media_item', itemId, {
      candidates: scored.length,
      languages: wantLanguages,
    });

    const stored = await this.prisma.subtitleCandidate.findMany({
      where: { itemId },
      orderBy: { score: 'desc' },
    });
    return { candidates: stored };
  }

  // --- download + install -------------------------------------------------

  /** Download a previously-searched candidate, validate, and install it. */
  async downloadCandidate(candidateId: string, ctx: AuditCtx) {
    const candidate = await this.prisma.subtitleCandidate.findUnique({ where: { id: candidateId } });
    if (!candidate) throw new NotFoundException('Candidate not found');

    // A title-only (level 4) match is never auto-installed; require an explicit user action.
    // Here the user IS explicitly asking, so we proceed — but we still reject a 'reject'-tier score.
    if (candidate.scoreTier === 'reject') {
      throw new NotFoundException('Candidate scored too low to install.');
    }

    const item = await this.prisma.mediaItem.findUnique({ where: { id: candidate.itemId }, include: { files: true } });
    if (!item) throw new NotFoundException('Item not found');
    const videoPath = item.files.find((f) => /\.(mkv|mp4|avi|m4v|ts|m2ts|wmv|mov|webm)$/i.test(f.path))?.path ?? item.path;

    const provider = await this.registry.get(candidate.provider);
    if (!provider) throw new NotFoundException(`Provider "${candidate.provider}" is not available.`);

    const normalized: NormalizedSubtitle = {
      provider: candidate.provider,
      providerFileId: candidate.providerFileId,
      language: candidate.language,
      releaseName: candidate.releaseName,
      filename: candidate.filename,
      downloadUrl: candidate.downloadUrl,
    };

    try {
      const bytes = await provider.download(normalized);

      // Validate BEFORE writing to disk — never install a broken subtitle.
      const structural = validateSubtitle(bytes.content, bytes.format);
      // Deep pass: cross-check the subtitle's end against the media's MEASURED
      // runtime (no binary — reuses the mediainfo probe already on the file).
      const runtimeSec =
        (await this.prisma.subtitleFingerprint.findUnique({ where: { itemId: item.id } }))?.runtimeSec ??
        item.files.find((f) => /\.(mkv|mp4|avi|m4v|ts|m2ts|wmv|mov|webm)$/i.test(f.path))?.durationSec ??
        null;
      const rc = runtimeCrossCheck(structural.endMs, runtimeSec);
      const issues = rc.issue ? [...structural.issues, rc.issue] : structural.issues;
      const valid = structural.valid && !rc.issue;
      const validation = { ...structural, valid, issues };
      const validationRow = await this.prisma.subtitleValidation.create({
        data: {
          format: validation.format,
          valid,
          cueCount: validation.cueCount,
          startMs: validation.startMs,
          endMs: validation.endMs,
          issues: issues as object,
          runtimeDeltaSec: rc.runtimeDeltaSec,
          method: runtimeSec != null ? 'mediainfo' : 'pure',
        },
      });

      if (!valid) {
        await this.history(item.id, 'validated', { provider: candidate.provider, language: candidate.language, message: 'validation failed' });
        this.realtime.broadcast(WS_EVENTS.SUBTITLE_VALIDATION_FAILED, { itemId: item.id, provider: candidate.provider, language: candidate.language, issues: validation.issues, at: new Date().toISOString() });
        this.emitDomain(NOTIFICATION_EVENTS.SUBTITLE_VALIDATION_FAILED, { mediaTitle: item.title, itemId: item.id, language: candidate.language, provider: candidate.provider });
        this.triggers.fire('subtitle.validation_failed', { title: item.title, itemId: item.id, language: candidate.language, provider: candidate.provider });
        await this.record(ctx, 'subtitle.download.rejected', 'media_item', item.id, { reason: 'invalid', provider: candidate.provider }, 'failure');
        return { installed: false, reason: 'validation_failed', validation };
      }

      const result = await this.install.install(videoPath, bytes.content, {
        language: candidate.language,
        forced: candidate.forced,
        sdh: candidate.hearingImpaired,
        format: bytes.format,
      });

      const download = await this.prisma.subtitleDownload.create({
        data: {
          itemId: item.id,
          provider: candidate.provider,
          language: candidate.language,
          forced: candidate.forced,
          hearingImpaired: candidate.hearingImpaired,
          path: result.path,
          releaseName: candidate.releaseName,
          score: candidate.score,
          scoreTier: candidate.scoreTier,
          matchLevel: candidate.matchLevel,
          fileSize: BigInt(bytes.byteLength),
          status: 'installed',
          validationId: validationRow.id,
          providerFileId: candidate.providerFileId,
        },
      });

      // Surface the installed sub to media_manager (its scanner dedups by path).
      await this.linkToMediaSubtitle(item.id, result.path, candidate.language, candidate.forced, candidate.hearingImpaired);

      await this.history(item.id, 'downloaded', { provider: candidate.provider, language: candidate.language, score: candidate.score, message: result.variant ? 'installed (variant name — original kept)' : 'installed' });
      this.realtime.broadcast(WS_EVENTS.SUBTITLE_DOWNLOADED, { itemId: item.id, provider: candidate.provider, language: candidate.language, path: result.path, at: new Date().toISOString() });
      this.emitDomain(NOTIFICATION_EVENTS.SUBTITLE_DOWNLOADED, { mediaTitle: item.title, itemId: item.id, language: candidate.language, provider: candidate.provider });
      this.triggers.fire('subtitle.downloaded', { title: item.title, itemId: item.id, language: candidate.language, provider: candidate.provider });
      await this.record(ctx, 'subtitle.download.installed', 'media_item', item.id, { provider: candidate.provider, language: candidate.language, score: candidate.score, path: result.path });

      return { installed: true, download, validation };
    } catch (err) {
      const message = (err as Error).message;
      await this.history(item.id, 'failed', { provider: candidate.provider, language: candidate.language, message });
      this.realtime.broadcast(WS_EVENTS.SUBTITLE_DOWNLOAD_FAILED, { itemId: item.id, provider: candidate.provider, language: candidate.language, error: message, at: new Date().toISOString() });
      this.emitDomain(NOTIFICATION_EVENTS.SUBTITLE_FAILED, { mediaTitle: item.title, itemId: item.id, language: candidate.language, provider: candidate.provider, error: message });
      await this.record(ctx, 'subtitle.download.failed', 'media_item', item.id, { provider: candidate.provider, error: message }, 'failure');
      return { installed: false, reason: 'download_failed', error: message };
    }
  }

  /** Validate arbitrary subtitle text (the Validation UI's dry-run). */
  validateText(content: string, ext?: string | null) {
    return validateSubtitle(content, ext);
  }

  // --- read models --------------------------------------------------------

  async listDownloads(itemId?: string) {
    return this.prisma.subtitleDownload.findMany({
      where: itemId ? { itemId } : undefined,
      include: { validation: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async listHistory(itemId?: string) {
    return this.prisma.subtitleHistory.findMany({
      where: itemId ? { itemId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async listCandidates(itemId: string) {
    return this.prisma.subtitleCandidate.findMany({ where: { itemId }, orderBy: { score: 'desc' } });
  }

  async dashboard() {
    const [downloads, installed, providers, byLanguage, recent] = await Promise.all([
      this.prisma.subtitleDownload.count(),
      this.prisma.subtitleDownload.count({ where: { status: 'installed' } }),
      this.providerSettings.list(),
      this.prisma.subtitleDownload.groupBy({ by: ['language'], _count: { _all: true } }),
      this.prisma.subtitleHistory.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    return {
      totals: { downloads, installed },
      providers: providers.map((p) => ({ provider: p.provider, isEnabled: p.isEnabled, healthy: p.healthy, quotaRemaining: p.quotaRemaining })),
      byLanguage: byLanguage.map((g) => ({ language: g.language, count: g._count._all })),
      recent,
    };
  }

  // --- helpers ------------------------------------------------------------

  private async linkToMediaSubtitle(itemId: string, path: string, language: string, forced: boolean, sdh: boolean) {
    const existing = await this.prisma.mediaSubtitle.findFirst({ where: { itemId, path } });
    if (existing) return;
    await this.prisma.mediaSubtitle.create({
      data: { itemId, path, language, forced, sdh, source: 'subtitle_intelligence' },
    });
  }

  private history(itemId: string | null, action: string, extra: { provider?: string; language?: string; score?: number; message?: string; metadata?: object } = {}) {
    return this.prisma.subtitleHistory.create({
      data: {
        itemId,
        action,
        provider: extra.provider ?? null,
        language: extra.language ?? null,
        score: extra.score ?? null,
        message: extra.message ?? null,
        metadata: (extra.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      },
    });
  }

  private emitDomain(event: string, payload: Record<string, unknown>) {
    this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, { event, payload, at: new Date().toISOString() });
  }

  private record(ctx: AuditCtx, action: string, objectType: string, objectId: string, metadata: Record<string, unknown>, result: 'success' | 'failure' = 'success') {
    return this.audit.record({ ...ctx, action, objectType, objectId, metadata, result });
  }
}
