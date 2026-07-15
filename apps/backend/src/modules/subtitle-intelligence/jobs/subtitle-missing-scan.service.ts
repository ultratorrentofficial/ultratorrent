/**
 * Missing-subtitle scan — the "keep libraries healthy" engine. For a library it
 * diffs each item's present subtitle languages (this module's downloads + the
 * sidecars Media Manager discovered) against the library's language policy,
 * raises a `subtitle.missing` domain event + automation trigger for every gap,
 * and — when auto-download is enabled — fetches the best acceptable candidate.
 *
 * Fully decoupled from the media pipeline: it reads MediaItem rows, so it covers
 * freshly-downloaded items on its next pass without any media-side hook. Runs
 * on-demand (bulk endpoint) and on a cadence (scheduler).
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NOTIFICATION_BUS_CHANNEL, NOTIFICATION_EVENTS } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { SettingsService } from '../../settings/settings.module';
import { SubtitleService } from '../subtitle.service';
import { SubtitleTriggerService } from '../automation/subtitle-trigger.service';
import { missingLanguages } from './missing-languages';

export const AUTO_DOWNLOAD_KEY = 'media.subtitles.autoDownload';

export interface MissingScanResult {
  libraryId: string;
  scanned: number;
  gaps: number;
  downloaded: number;
}

@Injectable()
export class SubtitleMissingScanService {
  private readonly logger = new Logger(SubtitleMissingScanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly subtitles: SubtitleService,
    private readonly triggers: SubtitleTriggerService,
    private readonly eventBus: EventEmitter2,
  ) {}

  /** Whether the missing scan may auto-download (global opt-in, default off). */
  async autoDownloadEnabled(): Promise<boolean> {
    return (await this.settings.get<boolean>(AUTO_DOWNLOAD_KEY)) === true;
  }

  /**
   * Scan one library for missing subtitles. Acts only when the library has a
   * language policy (required/preferred) — no policy means no surprises. When
   * `report` is provided, progress is streamed (0..100).
   */
  async scanLibrary(
    libraryId: string,
    report?: (progress: number, message?: string) => Promise<void>,
  ): Promise<MissingScanResult> {
    const library = await this.prisma.mediaLibrary.findUnique({ where: { id: libraryId } });
    if (!library) throw new NotFoundException('Library not found');

    const policy = await this.subtitles.getLanguageSettings(libraryId);
    const wanted = [
      ...new Set([...(policy.requiredLanguages as string[]), ...(policy.preferredLanguages as string[])]),
    ];
    if (wanted.length === 0) {
      return { libraryId, scanned: 0, gaps: 0, downloaded: 0 };
    }

    const autoDownload = await this.autoDownloadEnabled();
    const items = await this.prisma.mediaItem.findMany({
      where: { libraryId, matchStatus: { in: ['matched', 'manual'] } },
      include: { subtitles: true, subtitleDownloads: true },
    });

    let gaps = 0;
    let downloaded = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const present = [
        ...item.subtitles.map((s) => s.language),
        ...item.subtitleDownloads.map((d) => d.language),
      ];
      const missing = missingLanguages(present, wanted);
      if (missing.length === 0) continue;
      gaps++;

      // Raise the gap: Notification Center + automation trigger + history.
      this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, {
        event: NOTIFICATION_EVENTS.SUBTITLE_MISSING,
        payload: { mediaTitle: item.title, itemId: item.id, libraryId, languages: missing },
        at: new Date().toISOString(),
      });
      this.triggers.fire('subtitle.missing', {
        title: item.title,
        itemId: item.id,
        libraryId,
        languages: missing.join(','),
      });

      if (autoDownload) {
        downloaded += await this.autoFetch(item.id, missing, policy.minimumScore as number);
      }
      if (report && items.length > 0) await report(Math.round(((i + 1) / items.length) * 100));
    }

    this.logger.log(`Missing scan for "${library.name}": ${gaps} gap(s), ${downloaded} downloaded of ${items.length} item(s)`);
    return { libraryId, scanned: items.length, gaps, downloaded };
  }

  /** Search + install the best acceptable candidate per missing language. */
  private async autoFetch(itemId: string, missing: string[], minScore: number): Promise<number> {
    let count = 0;
    try {
      const { candidates } = await this.subtitles.search(itemId, { languages: missing }, {});
      for (const lang of missing) {
        const best = candidates.find(
          (c) =>
            c.language.toLowerCase().startsWith(lang.toLowerCase().split(/[-_]/)[0]) &&
            c.score >= minScore &&
            (c.scoreTier === 'auto' || c.scoreTier === 'download'),
        );
        if (best) {
          const res = await this.subtitles.downloadCandidate(best.id, {});
          if (res.installed) count++;
        }
      }
    } catch (err) {
      this.logger.warn(`auto-fetch for ${itemId} failed: ${(err as Error).message}`);
    }
    return count;
  }
}
