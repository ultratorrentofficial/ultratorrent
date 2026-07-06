import { Injectable, Logger } from '@nestjs/common';
import { WS_EVENTS } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { SettingsService } from '../../settings/settings.module';
import { AuditService } from '../../audit/audit.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import {
  normalizeShowStatus,
  normalizeTitle,
  recommendationFor,
  type ShowDetails,
  type ShowSearchHit,
  type ShowStatusResult,
  type TvShowStatusProvider,
} from './tv-show-status-provider';
import { TmdbTvShowStatusProvider } from './tmdb-show-status.provider';
import { ImdbTvShowStatusProvider } from './imdb-show-status.provider';
import { LocalNfoTvShowStatusProvider } from './local-show-status.provider';

export interface StatusLookupContext {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface StatusLookupQuery {
  title: string;
  year?: number | null;
  provider?: string;
}

/**
 * Resolves a TV show's airing status by trying providers in confidence order
 * (TMDB when a key is configured → IMDb dataset → local library), normalizing
 * each provider's answer, caching it, auditing, and broadcasting an event. RSS
 * services depend on this — no provider-specific status logic lives in RSS.
 */
@Injectable()
export class TvShowStatusService {
  private readonly logger = new Logger(TvShowStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private async buildProviders(): Promise<TvShowStatusProvider[]> {
    const key =
      (await this.settings.get<string>('media.tmdbApiKey')) ?? process.env.TMDB_API_KEY;
    const providers: TvShowStatusProvider[] = [];
    if (key) providers.push(new TmdbTvShowStatusProvider(key));
    providers.push(new ImdbTvShowStatusProvider(this.prisma));
    providers.push(new LocalNfoTvShowStatusProvider(this.prisma));
    return providers;
  }

  /** Capabilities of every configured provider (for diagnostics/UI). */
  async capabilities() {
    return (await this.buildProviders()).map((p) => p.getProviderCapabilities());
  }

  /** Resolve one show's status, trying providers in order until one matches. */
  async lookup(query: StatusLookupQuery, ctx: StatusLookupContext = {}): Promise<ShowStatusResult> {
    const title = query.title.trim();
    try {
      const providers = (await this.buildProviders()).filter(
        (p) => !query.provider || p.name === query.provider,
      );
      for (const provider of providers) {
        const hits = await provider.searchShow(title, query.year ?? null);
        const hit = this.pickHit(hits, title, query.year ?? null);
        if (!hit) continue;
        const details = await provider.getShowDetails(hit.providerShowId);
        if (!details) continue;
        const result = this.buildResult(title, provider, details);
        await this.cache(result);
        await this.audit.record({
          userId: ctx.userId,
          action: 'rss.show_status.lookup',
          objectType: 'tv_show_status',
          objectId: `${result.provider}:${result.providerShowId ?? title}`,
          result: 'success',
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          metadata: { title, normalizedStatus: result.normalizedStatus, recommendation: result.recommendation },
        });
        this.realtime.broadcast(WS_EVENTS.RSS_SHOW_STATUS_LOOKUP_COMPLETED, {
          title,
          provider: result.provider,
          normalizedStatus: result.normalizedStatus,
          recommendation: result.recommendation,
          at: new Date().toISOString(),
        });
        return result;
      }
      // No provider matched the title — a completed lookup with an unknown result.
      const unknown = this.unknownResult(title, providers.length ? 'not_found' : 'no_provider');
      this.realtime.broadcast(WS_EVENTS.RSS_SHOW_STATUS_LOOKUP_COMPLETED, {
        title,
        provider: unknown.provider,
        normalizedStatus: unknown.normalizedStatus,
        recommendation: unknown.recommendation,
        at: new Date().toISOString(),
      });
      return unknown;
    } catch (err) {
      this.logger.warn(`show-status lookup failed for "${title}": ${(err as Error).message}`);
      this.realtime.broadcast(WS_EVENTS.RSS_SHOW_STATUS_LOOKUP_FAILED, {
        title,
        error: (err as Error).message,
        at: new Date().toISOString(),
      });
      await this.audit.record({
        userId: ctx.userId,
        action: 'rss.show_status.lookup',
        objectType: 'tv_show_status',
        objectId: title,
        result: 'failure',
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        metadata: { title, error: (err as Error).message },
      });
      return this.unknownResult(title, 'error');
    }
  }

  async lookupBatch(queries: StatusLookupQuery[], ctx: StatusLookupContext = {}): Promise<ShowStatusResult[]> {
    const out: ShowStatusResult[] = [];
    for (const q of queries.slice(0, 50)) out.push(await this.lookup(q, ctx));
    return out;
  }

  /**
   * Authoritative status for a rule save: read the cache by provider + id (fast),
   * else re-resolve live. Returns null when the id can't be resolved.
   */
  async resolveByProviderId(
    provider: string,
    providerShowId: string,
    force = false,
  ): Promise<ShowStatusResult | null> {
    if (!force) {
      const cached = await this.prisma.tvShowStatus.findUnique({
        where: { provider_providerShowId: { provider, providerShowId } },
      });
      if (cached) return this.fromCacheRow(cached);
    }
    const impl = (await this.buildProviders()).find((p) => p.name === provider);
    if (!impl) return null;
    const details = await impl.getShowDetails(providerShowId);
    if (!details) return null;
    const result = this.buildResult(details.title, impl, details);
    await this.cache(result);
    return result;
  }

  // --- internals -----------------------------------------------------------

  private pickHit(hits: ShowSearchHit[], title: string, year: number | null): ShowSearchHit | null {
    if (!hits.length) return null;
    const key = normalizeTitle(title);
    const exact = hits.filter((h) => normalizeTitle(h.title) === key);
    const pool = exact.length ? exact : hits;
    if (year) {
      const byYear = pool.find((h) => h.year === year);
      if (byYear) return byYear;
    }
    return pool[0];
  }

  private buildResult(title: string, provider: TvShowStatusProvider, d: ShowDetails): ShowStatusResult {
    const normalizedStatus = normalizeShowStatus({
      providerStatus: d.originalStatus,
      endYear: d.endYear ?? null,
      hasFutureEpisode: !!d.nextEpisode?.airDate,
      lastAirDate: d.lastAirDate,
      assumeContinuing: d.assumeContinuing,
    });
    const recommendation = recommendationFor(normalizedStatus);
    const warnings: string[] = [];
    if (normalizedStatus === 'unknown') warnings.push('status_unconfirmed');
    if (provider.name === 'local') warnings.push('local_only');
    const baseConfidence = provider.getProviderCapabilities().confidence;
    return {
      title,
      normalizedTitle: normalizeTitle(title),
      provider: provider.name,
      providerShowId: d.providerShowId,
      originalStatus: d.originalStatus,
      normalizedStatus,
      recommendation,
      confidence: Math.round(baseConfidence * (normalizedStatus === 'unknown' ? 0.5 : 1) * 100) / 100,
      firstAirDate: d.firstAirDate,
      lastAirDate: d.lastAirDate,
      nextEpisodeAirDate: d.nextEpisode?.airDate ?? null,
      lastEpisodeTitle: d.lastEpisode?.title ?? null,
      nextEpisodeTitle: d.nextEpisode?.title ?? null,
      totalSeasons: d.totalSeasons,
      totalEpisodes: d.totalEpisodes,
      overview: d.overview,
      posterUrl: d.posterUrl,
      warnings,
    };
  }

  private unknownResult(title: string, reason: string): ShowStatusResult {
    return {
      title,
      normalizedTitle: normalizeTitle(title),
      provider: 'none',
      providerShowId: null,
      originalStatus: null,
      normalizedStatus: 'unknown',
      recommendation: 'unknown',
      confidence: 0,
      firstAirDate: null,
      lastAirDate: null,
      nextEpisodeAirDate: null,
      lastEpisodeTitle: null,
      nextEpisodeTitle: null,
      totalSeasons: null,
      totalEpisodes: null,
      overview: null,
      posterUrl: null,
      warnings: [reason === 'no_provider' ? 'no_provider_configured' : 'status_unconfirmed'],
    };
  }

  private asDate(iso: string | null): Date | null {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private async cache(r: ShowStatusResult): Promise<void> {
    if (!r.providerShowId || r.provider === 'none') return;
    const data = {
      provider: r.provider,
      providerShowId: r.providerShowId,
      title: r.title,
      normalizedTitle: r.normalizedTitle,
      originalStatus: r.originalStatus,
      normalizedStatus: r.normalizedStatus,
      recommendation: r.recommendation,
      confidence: r.confidence,
      firstAirDate: this.asDate(r.firstAirDate),
      lastAirDate: this.asDate(r.lastAirDate),
      nextEpisodeAirDate: this.asDate(r.nextEpisodeAirDate),
      lastEpisodeTitle: r.lastEpisodeTitle,
      nextEpisodeTitle: r.nextEpisodeTitle,
      totalSeasons: r.totalSeasons,
      totalEpisodes: r.totalEpisodes,
      overview: r.overview,
      posterUrl: r.posterUrl,
      warnings: r.warnings,
      checkedAt: new Date(),
    };
    await this.prisma.tvShowStatus.upsert({
      where: { provider_providerShowId: { provider: r.provider, providerShowId: r.providerShowId } },
      create: data,
      update: data,
    });
  }

  private fromCacheRow(row: {
    provider: string;
    providerShowId: string;
    title: string;
    normalizedTitle: string;
    originalStatus: string | null;
    normalizedStatus: string;
    recommendation: string;
    confidence: number;
    firstAirDate: Date | null;
    lastAirDate: Date | null;
    nextEpisodeAirDate: Date | null;
    lastEpisodeTitle: string | null;
    nextEpisodeTitle: string | null;
    totalSeasons: number | null;
    totalEpisodes: number | null;
    overview: string | null;
    posterUrl: string | null;
    warnings: unknown;
  }): ShowStatusResult {
    const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    return {
      title: row.title,
      normalizedTitle: row.normalizedTitle,
      provider: row.provider,
      providerShowId: row.providerShowId,
      originalStatus: row.originalStatus,
      normalizedStatus: row.normalizedStatus as ShowStatusResult['normalizedStatus'],
      recommendation: row.recommendation as ShowStatusResult['recommendation'],
      confidence: row.confidence,
      firstAirDate: iso(row.firstAirDate),
      lastAirDate: iso(row.lastAirDate),
      nextEpisodeAirDate: iso(row.nextEpisodeAirDate),
      lastEpisodeTitle: row.lastEpisodeTitle,
      nextEpisodeTitle: row.nextEpisodeTitle,
      totalSeasons: row.totalSeasons,
      totalEpisodes: row.totalEpisodes,
      overview: row.overview,
      posterUrl: row.posterUrl,
      warnings: Array.isArray(row.warnings) ? (row.warnings as string[]) : [],
    };
  }
}
