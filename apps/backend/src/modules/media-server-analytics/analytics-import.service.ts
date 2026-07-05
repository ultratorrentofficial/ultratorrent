import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { MediaAnalyticsImportSource } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { getAnalyticsImportProvider, ImportContext } from './analytics-import-provider';

interface SourceInput {
  name?: string;
  type?: string;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
  syncEnabled?: boolean;
}

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

  listJobs() {
    return this.prisma.mediaAnalyticsImportJob.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
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

  private async executeJob(jobId: string, source: MediaAnalyticsImportSource, userId?: string) {
    const provider = getAnalyticsImportProvider(source.type);
    const ctx = this.ctx(source);
    await this.prisma.mediaAnalyticsImportJob.update({ where: { id: jobId }, data: { status: 'running', startedAt: new Date() } });
    this.realtime.broadcast('media_server.import.started', { jobId, sourceId: source.id });
    try {
      const info = await provider.getImportSourceInfo(ctx);
      const total = info.totalHistory;
      await this.prisma.mediaAnalyticsImportJob.update({ where: { id: jobId }, data: { totalRecords: total } });

      let start = 0;
      let processed = 0;
      let imported = 0;
      let skipped = 0;
      while (total === 0 || start < total) {
        const page = await provider.getWatchHistory(ctx, { start, length: PAGE });
        if (page.records.length === 0) break;
        const rows = page.records.map((r) => ({
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
          importSource: 'tautulli',
          importedAt: new Date(),
        }));
        const res = await this.prisma.mediaServerWatchHistory.createMany({ data: rows, skipDuplicates: true });
        imported += res.count;
        skipped += rows.length - res.count;
        processed += page.records.length;
        start += page.records.length;
        const progress = total ? Math.min(100, Math.round((processed / total) * 100)) : 100;
        await this.prisma.mediaAnalyticsImportJob.update({
          where: { id: jobId },
          data: { processedRecords: processed, importedRecords: imported, skippedRecords: skipped, progress },
        });
        this.realtime.broadcast('media_server.import.progress', { jobId, progress, processed, total });
        if (page.records.length < PAGE) break;
      }

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
