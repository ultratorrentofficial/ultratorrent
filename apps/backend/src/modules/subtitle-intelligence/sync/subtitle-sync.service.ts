/**
 * Synchronization workflow: analyze → sync → validate → PRESERVE the original →
 * install the synced copy as the active sidecar → record the result.
 *
 * The original is never overwritten (spec: "keep both") — it is copied to a
 * `.orig` sibling before the active sidecar is replaced with the synced version,
 * so a bad sync is always revertible. Automatic sync uses FFsubsync when
 * installed; otherwise the caller supplies a manual offset. Filesystem access is
 * confined to the ops hard roots.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { readFile, writeFile, access } from 'node:fs/promises';
import * as path from 'node:path';
import { NOTIFICATION_BUS_CHANNEL, NOTIFICATION_EVENTS, WS_EVENTS } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { FilePathService } from '../../files/file-path.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { AuditService, type AuditEntry } from '../../audit/audit.service';
import { detectSubtitleFormat } from '../providers/subtitle-provider';
import { SubtitleTriggerService } from '../automation/subtitle-trigger.service';
import { ManualOffsetProvider } from './manual-offset.provider';
import { FfsubsyncProvider } from './ffsubsync.provider';
import type { SubtitleSynchronizationProvider, SyncInput } from './subtitle-sync-provider';

type AuditCtx = Pick<AuditEntry, 'userId' | 'ipAddress' | 'userAgent'>;

export interface SyncRequest {
  /** `auto` = FFsubsync (audio); `manual` = apply the supplied offset/drift. */
  method?: 'auto' | 'manual';
  offsetMs?: number;
  driftFactor?: number;
}

/** Insert `.orig` before the extension: `Movie.en.srt` → `Movie.en.orig.srt`. Pure. */
export function originalBackupPath(activePath: string): string {
  const ext = path.extname(activePath);
  return `${activePath.slice(0, activePath.length - ext.length)}.orig${ext}`;
}

@Injectable()
export class SubtitleSyncService {
  private readonly logger = new Logger(SubtitleSyncService.name);
  private readonly ffsubsync = new FfsubsyncProvider();
  private readonly manual = new ManualOffsetProvider();

  constructor(
    private readonly prisma: PrismaService,
    private readonly filePath: FilePathService,
    private readonly realtime: RealtimeGateway,
    private readonly audit: AuditService,
    private readonly eventBus: EventEmitter2,
    private readonly triggers: SubtitleTriggerService,
  ) {}

  /** Which synchronizers can actually run here (drives the UI). */
  async capabilities() {
    const ffAvailable = await this.ffsubsync.isAvailable();
    return {
      ffsubsync: { available: ffAvailable, version: this.ffsubsync.version },
      manual: { available: true },
    };
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Synchronize an installed subtitle. `auto` needs FFsubsync; when it is not
   * installed the call is recorded as skipped (never an error) unless a manual
   * offset was supplied.
   */
  async synchronize(downloadId: string, req: SyncRequest, ctx: AuditCtx) {
    const download = await this.prisma.subtitleDownload.findUnique({
      where: { id: downloadId },
      include: { item: { include: { files: true } } },
    });
    if (!download) throw new NotFoundException('Download not found');

    const activePath = this.filePath.assertWithinHardRoots(download.path);
    const format = detectSubtitleFormat(activePath) ?? 'srt';
    const videoPath =
      download.item.files.find((f) => /\.(mkv|mp4|avi|m4v|ts|m2ts|wmv|mov|webm)$/i.test(f.path))?.path ??
      download.item.path;

    // Choose the provider.
    const wantManual = req.method === 'manual' || req.offsetMs != null;
    let provider: SubtitleSynchronizationProvider = this.manual;
    if (!wantManual) {
      if (await this.ffsubsync.isAvailable()) {
        provider = this.ffsubsync;
      } else {
        await this.recordSync(download.id, {
          provider: 'ffsubsync',
          method: 'audio',
          status: 'skipped',
          originalPath: activePath,
          syncedPath: activePath,
          message: 'ffsubsync not installed',
        });
        return { synced: false, reason: 'ffsubsync_unavailable' as const };
      }
    }

    const content = await readFile(activePath, 'utf8');
    const input: SyncInput = { videoPath, content, format, offsetMs: req.offsetMs, driftFactor: req.driftFactor };

    try {
      const result = await provider.synchronize(input);
      if (!provider.validateSync(result)) {
        await this.recordSync(download.id, {
          provider: provider.name,
          method: result.method,
          version: provider.version ?? undefined,
          offsetMs: result.offsetMs,
          driftFactor: result.driftFactor,
          status: 'failed',
          originalPath: activePath,
          syncedPath: activePath,
          message: 'produced an implausible result',
        });
        return { synced: false, reason: 'implausible_result' as const };
      }

      // Preserve the original once (never overwrite an existing backup).
      const backup = this.filePath.assertWithinHardRoots(originalBackupPath(activePath));
      if (!(await this.exists(backup))) await writeFile(backup, content, 'utf8');

      // Install the synced version as the active sidecar.
      await writeFile(activePath, result.content, 'utf8');

      const sync = await this.recordSync(download.id, {
        provider: provider.name,
        method: result.method,
        version: provider.version ?? undefined,
        offsetMs: result.offsetMs,
        driftFactor: result.driftFactor,
        confidence: result.confidence ?? undefined,
        matchedRegions: result.matchedRegions,
        status: 'applied',
        originalPath: backup,
        syncedPath: activePath,
      });

      await this.history(download.itemId, 'synchronized', download.provider, download.language, `${provider.name} (${result.method})`);
      this.realtime.broadcast(WS_EVENTS.SUBTITLE_SYNCHRONIZED, {
        itemId: download.itemId,
        downloadId: download.id,
        provider: provider.name,
        method: result.method,
        offsetMs: result.offsetMs,
        at: new Date().toISOString(),
      });
      this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, {
        event: NOTIFICATION_EVENTS.SUBTITLE_SYNCHRONIZED,
        payload: { mediaTitle: download.item.title, itemId: download.itemId, language: download.language, provider: provider.name },
        at: new Date().toISOString(),
      });
      this.triggers.fire('subtitle.synchronized', { title: download.item.title, itemId: download.itemId, language: download.language, provider: provider.name });
      await this.audit.record({
        ...ctx,
        action: 'subtitle.synchronized',
        objectType: 'media_item',
        objectId: download.itemId,
        metadata: { provider: provider.name, method: result.method, offsetMs: result.offsetMs },
      });

      return { synced: true, sync };
    } catch (err) {
      const message = (err as Error).message;
      await this.recordSync(download.id, {
        provider: provider.name,
        method: wantManual ? 'offset' : 'audio',
        status: 'failed',
        originalPath: activePath,
        syncedPath: activePath,
        message,
      });
      await this.audit.record({ ...ctx, action: 'subtitle.synchronize.failed', objectType: 'media_item', objectId: download.itemId, result: 'failure', metadata: { error: message } });
      return { synced: false, reason: 'sync_failed' as const, error: message };
    }
  }

  async listForDownload(downloadId: string) {
    return this.prisma.subtitleSynchronization.findMany({
      where: { downloadId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private recordSync(
    downloadId: string,
    data: {
      provider: string;
      method: string;
      version?: string;
      offsetMs?: number;
      driftFactor?: number;
      confidence?: number;
      matchedRegions?: unknown;
      status: string;
      originalPath: string;
      syncedPath: string;
      message?: string;
    },
  ) {
    return this.prisma.subtitleSynchronization.create({
      data: {
        downloadId,
        provider: data.provider,
        method: data.method,
        version: data.version ?? null,
        offsetMs: data.offsetMs ?? 0,
        driftFactor: data.driftFactor ?? 1,
        confidence: data.confidence ?? null,
        matchedRegions: (data.matchedRegions ?? undefined) as object | undefined,
        status: data.status,
        originalPath: data.originalPath,
        syncedPath: data.syncedPath,
        message: data.message ?? null,
      },
    });
  }

  private history(itemId: string | null, action: string, provider: string, language: string, message: string) {
    return this.prisma.subtitleHistory.create({
      data: { itemId, action, provider, language, message },
    });
  }
}
