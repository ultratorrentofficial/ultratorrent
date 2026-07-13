import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { MediaAnalyticsImportSource } from '@prisma/client';
import { paginate, parsePage } from '../../common/pagination';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { getAnalyticsImportProvider, ImportContext, StreamQuality } from './analytics-import-provider';

interface SourceInput {
  name?: string;
  type?: string;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
  syncEnabled?: boolean;
}

/** Parallel stream-quality lookups. The source is a small NAS — do not flood it. */
const QUALITY_CONCURRENCY = 8;

const PAGE = 500;

/**
 * Tautulli (and future) analytics import: source management with an encrypted
 * API key, connection test, preview, and a background import job that streams
 * historical watch history into `MediaServerWatchHistory` (deduped by
 * `(importSourceId, providerHistoryId)`), reporting progress over WebSocket.
 */
@Injectable()
export class AnalyticsImportService {
  private readonly logger = new Logger(AnalyticsImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipher,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private redact(s: MediaAnalyticsImportSource) {
    const { encryptedApiKey, ...safe } = s;
    return { ...safe, hasApiKey: Boolean(encryptedApiKey) };
  }

  listSources() {
    return this.prisma.mediaAnalyticsImportSource
      .findMany({ orderBy: { name: 'asc' } })
      .then((rows) => rows.map((r) => this.redact(r)));
  }

  async getSource(id: string) {
    return this.redact(await this.load(id));
  }

  async createSource(input: SourceInput, userId?: string) {
    if (!input.baseUrl) throw new BadRequestException('baseUrl is required');
    const row = await this.prisma.mediaAnalyticsImportSource.create({
      data: {
        name: input.name ?? 'Tautulli',
        type: input.type ?? 'tautulli',
        baseUrl: input.baseUrl,
        encryptedApiKey: input.apiKey ? this.cipher.encrypt(input.apiKey) : null,
        enabled: input.enabled ?? true,
        syncEnabled: input.syncEnabled ?? false,
      },
    });
    await this.audit.record({ userId, action: 'media_server_analytics.import_source.created', objectType: 'media_analytics_import_source', objectId: row.id });
    return this.redact(row);
  }

  async updateSource(id: string, input: SourceInput, userId?: string) {
    await this.load(id);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.baseUrl !== undefined) data.baseUrl = input.baseUrl;
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.syncEnabled !== undefined) data.syncEnabled = input.syncEnabled;
    // A blank / redaction-marker apiKey means "keep existing".
    if (input.apiKey && !/^•+$/.test(input.apiKey)) data.encryptedApiKey = this.cipher.encrypt(input.apiKey);
    const row = await this.prisma.mediaAnalyticsImportSource.update({ where: { id }, data });
    await this.audit.record({ userId, action: 'media_server_analytics.import_source.updated', objectType: 'media_analytics_import_source', objectId: id });
    return this.redact(row);
  }

  async removeSource(id: string, userId?: string) {
    await this.load(id);
    await this.prisma.mediaAnalyticsImportSource.delete({ where: { id } });
    await this.audit.record({ userId, action: 'media_server_analytics.import_source.deleted', objectType: 'media_analytics_import_source', objectId: id });
    return { ok: true as const };
  }

  async test(id: string, userId?: string) {
    const source = await this.load(id);
    const provider = getAnalyticsImportProvider(source.type);
    const result = await provider.testConnection(this.ctx(source));
    await this.prisma.mediaAnalyticsImportSource.update({
      where: { id },
      data: { lastConnectionTestAt: new Date(), status: result.ok ? 'connected' : 'error' },
    });
    if (!result.ok) {
      await this.audit.record({ userId, action: 'media_server_analytics.import_source.test_failed', objectType: 'media_analytics_import_source', objectId: id, result: 'failure', metadata: { message: result.message } });
    }
    return result;
  }

  async preview(id: string) {
    const source = await this.load(id);
    const provider = getAnalyticsImportProvider(source.type);
    return provider.getImportSourceInfo(this.ctx(source));
  }

  listJobs(page?: string, pageSize?: string) {
    return paginate(this.prisma.mediaAnalyticsImportJob, { orderBy: { createdAt: 'desc' } }, parsePage(page, pageSize));
  }

  async getJob(id: string) {
    const job = await this.prisma.mediaAnalyticsImportJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('Import job not found');
    return job;
  }

  /** Start a one-time import. Runs detached; poll the job or watch WS for progress. */
  async runImport(sourceId: string, userId?: string) {
    const source = await this.load(sourceId);
    if (!source.encryptedApiKey) throw new BadRequestException('Set an API key before importing.');
    const job = await this.prisma.mediaAnalyticsImportJob.create({
      data: { sourceId, status: 'pending', mode: 'one_time', createdById: userId },
    });
    void this.executeJob(job.id, source, userId);
    return job;
  }

  /**
   * Stream quality for a batch of history rows, keyed by providerHistoryId.
   *
   * Bounded concurrency: the source is a single small server (a NAS, typically), and
   * a full first import is tens of thousands of lookups — firing them all at once
   * would simply knock it over. Failures are swallowed per row: a play whose quality
   * we cannot read is still a play, and must not fail the import.
   */
  private async fetchQuality(
    provider: ReturnType<typeof getAnalyticsImportProvider>,
    ctx: ImportContext,
    records: { providerHistoryId?: string }[],
  ): Promise<Map<string, StreamQuality>> {
    const out = new Map<string, StreamQuality>();
    const ids = records.map((r) => r.providerHistoryId).filter(Boolean) as string[];
    let i = 0;
    const worker = async () => {
      for (;;) {
        const id = ids[i++];
        if (id === undefined) return;
        try {
          const q = await provider.getStreamQuality(ctx, id);
          if (q) out.set(id, q);
        } catch {
          /* a row we can't read the quality of is still a play — keep going */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(QUALITY_CONCURRENCY, ids.length) }, worker));
    return out;
  }

  /**
   * Page through one slice of the source's history and persist it.
   *
   * When `libraryName` is given, every row in the slice belongs to that library — so a
   * row already imported WITHOUT one is healed in place. Re-running the import would
   * otherwise fix nothing: `skipDuplicates` skips the existing row, null library and
   * all, and the operator would keep staring at an "Unknown" bucket holding 99% of
   * their plays.
   */
  private async importPages(
    provider: ReturnType<typeof getAnalyticsImportProvider>,
    ctx: ImportContext,
    source: MediaAnalyticsImportSource,
    jobId: string,
    total: number,
    counters: { processed: number; imported: number; skipped: number },
    sectionId?: string,
    libraryName?: string,
  ): Promise<void> {
    let start = 0;
    for (;;) {
      const page = await provider.getWatchHistory(ctx, { start, length: PAGE, sectionId, libraryName });
      if (page.records.length === 0) break;

      // Which of these do we already have, and do they still lack their quality?
      const ids = page.records.map((r) => r.providerHistoryId).filter(Boolean) as string[];
      const existing = await this.prisma.mediaServerWatchHistory.findMany({
        where: { importSourceId: source.id, providerHistoryId: { in: ids } },
        select: { providerHistoryId: true, resolution: true, libraryName: true },
      });
      const have = new Map(existing.map((e) => [e.providerHistoryId!, e]));

      // Fetch stream quality ONLY where it is missing — a row already enriched costs
      // nothing on a re-import. A history row carries no resolution/codec/bitrate at
      // all, so this per-row lookup is the only way to get it, and it is why the
      // "Quality Distribution" chart read ~99% "Unknown".
      const needQuality = page.records.filter((r) => {
        const e = r.providerHistoryId ? have.get(r.providerHistoryId) : undefined;
        return !e || e.resolution == null;
      });
      const quality = await this.fetchQuality(provider, ctx, needQuality);

      const rows = page.records.map((r) => {
        const q = (r.providerHistoryId && quality.get(r.providerHistoryId)) || {};
        return {
          importSourceId: source.id,
          providerHistoryId: r.providerHistoryId,
          providerUserId: r.providerUserId,
          userName: r.userName,
          title: r.title,
          mediaType: r.mediaType,
          libraryName: r.libraryName,
          device: r.device,
          client: r.client,
          ipAddress: r.ipAddress,
          startedAt: r.startedAt,
          stoppedAt: r.stoppedAt,
          watchedSeconds: r.watchedSeconds,
          percentComplete: r.percentComplete,
          playbackMethod: r.playbackMethod,
          resolution: q.resolution,
          videoCodec: q.videoCodec,
          audioCodec: q.audioCodec,
          container: q.container,
          bitrateKbps: q.bitrateKbps,
          importSource: 'tautulli',
          importedAt: new Date(),
        };
      });

      const res = await this.prisma.mediaServerWatchHistory.createMany({ data: rows, skipDuplicates: true });
      counters.imported += res.count;
      counters.skipped += rows.length - res.count;

      // Heal rows we already had. `createMany` SKIPS them (the unique key), so without
      // this a re-import fixes nothing and the operator keeps staring at an "Unknown"
      // bucket holding 99% of their plays.
      for (const row of rows) {
        const e = row.providerHistoryId ? have.get(row.providerHistoryId) : undefined;
        if (!e) continue;
        const patch: Record<string, unknown> = {};
        if (e.libraryName == null && row.libraryName) patch.libraryName = row.libraryName;
        if (e.resolution == null && row.resolution) {
          patch.resolution = row.resolution;
          patch.videoCodec = row.videoCodec;
          patch.audioCodec = row.audioCodec;
          patch.container = row.container;
          patch.bitrateKbps = row.bitrateKbps;
        }
        if (Object.keys(patch).length === 0) continue;
        await this.prisma.mediaServerWatchHistory.updateMany({
          where: { importSourceId: source.id, providerHistoryId: row.providerHistoryId },
          data: patch,
        });
      }

      counters.processed += page.records.length;
      start += page.records.length;
      const progress = total ? Math.min(100, Math.round((counters.processed / total) * 100)) : 100;
      await this.prisma.mediaAnalyticsImportJob.update({
        where: { id: jobId },
        data: {
          processedRecords: counters.processed,
          importedRecords: counters.imported,
          skippedRecords: counters.skipped,
          progress,
        },
      });
      this.realtime.broadcast('media_server.import.progress', { jobId, progress, processed: counters.processed, total });
      if (page.records.length < PAGE) break;
    }
  }

  private async executeJob(jobId: string, source: MediaAnalyticsImportSource, userId?: string) {
    const provider = getAnalyticsImportProvider(source.type);
    const ctx = this.ctx(source);
    await this.prisma.mediaAnalyticsImportJob.update({ where: { id: jobId }, data: { status: 'running', startedAt: new Date() } });
    this.realtime.broadcast('media_server.import.started', { jobId, sourceId: source.id });
    try {
      const info = await provider.getImportSourceInfo(ctx);
      const total = info.totalHistory;
      await this.prisma.mediaAnalyticsImportJob.update({ where: { id: jobId }, data: { totalRecords: total } });

      const counters = { processed: 0, imported: 0, skipped: 0 };

      // Import PER LIBRARY, then once unfiltered.
      //
      // Tautulli's `get_history` rows carry no library field at all — the importer read
      // `r.library_name`, which is always undefined, so 99% of rows landed with a null
      // library and the analytics "Libraries" report attributed nearly everything to a
      // single "Unknown" bucket. The only thing that knows a row's library is the
      // section we filtered by, so we ask per section and stamp the name.
      //
      // The final unfiltered pass catches history that belongs to no current section
      // (clips, live TV, a library since deleted). Those genuinely have no library, and
      // `@@unique([importSourceId, providerHistoryId])` + `skipDuplicates` means the
      // rows already imported per-section are not touched by it.
      const libraries = await provider.getLibraries(ctx).catch((err) => {
        this.logger.warn(`Could not list libraries; importing without them: ${(err as Error).message}`);
        return [] as { sectionId: string; name: string }[];
      });

      for (const lib of libraries) {
        await this.importPages(provider, ctx, source, jobId, total, counters, lib.sectionId, lib.name);
      }
      await this.importPages(provider, ctx, source, jobId, total, counters);

      const { imported, skipped } = counters;
      await this.prisma.mediaAnalyticsImportJob.update({ where: { id: jobId }, data: { status: 'completed', progress: 100, completedAt: new Date() } });
      await this.prisma.mediaAnalyticsImportSource.update({ where: { id: source.id }, data: { lastImportAt: new Date(), status: 'imported' } });
      this.realtime.broadcast('media_server.import.completed', { jobId, imported, skipped });
      await this.audit.record({ userId, action: 'media_server_analytics.import.completed', objectType: 'media_analytics_import_job', objectId: jobId, metadata: { imported, skipped } });
    } catch (err) {
      const message = (err as Error).message;
      await this.prisma.mediaAnalyticsImportJob.update({ where: { id: jobId }, data: { status: 'failed', completedAt: new Date(), errors: [message] as unknown as object } });
      this.realtime.broadcast('media_server.import.failed', { jobId, error: message });
      await this.audit.record({ userId, action: 'media_server_analytics.import.failed', objectType: 'media_analytics_import_job', objectId: jobId, result: 'failure', metadata: { message } });
      this.logger.warn(`Analytics import ${jobId} failed: ${message}`);
    }
  }

  private ctx(source: MediaAnalyticsImportSource): ImportContext {
    return { baseUrl: source.baseUrl, apiKey: source.encryptedApiKey ? this.cipher.decrypt(source.encryptedApiKey) : '' };
  }

  private async load(id: string) {
    const row = await this.prisma.mediaAnalyticsImportSource.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Import source not found');
    return row;
  }
}
