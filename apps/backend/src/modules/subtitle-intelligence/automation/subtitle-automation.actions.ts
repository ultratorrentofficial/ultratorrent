/**
 * Executes Subtitle Intelligence automation actions. Free of any AutomationEngine
 * dependency (the engine depends on this, not vice-versa) — the same shape as
 * MediaAutomationActions. `execute(type, params, context)` is called by the engine
 * for any action id in SUBTITLE_ACTION_TYPES.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SubtitleService } from '../subtitle.service';
import { SubtitleMissingScanService } from '../jobs/subtitle-missing-scan.service';

@Injectable()
export class SubtitleAutomationActions {
  private readonly logger = new Logger(SubtitleAutomationActions.name);

  constructor(
    private readonly subtitles: SubtitleService,
    private readonly missingScan: SubtitleMissingScanService,
  ) {}

  async execute(type: string, params: Record<string, unknown>, context: Record<string, unknown> = {}): Promise<void> {
    switch (type) {
      case 'subtitle_scan_missing': {
        const libraryId = String(params.libraryId ?? context.libraryId ?? '');
        if (libraryId) await this.missingScan.scanLibrary(libraryId);
        break;
      }
      case 'subtitle_download': {
        const itemId = String(params.itemId ?? context.itemId ?? '');
        if (!itemId) break;
        const languages =
          typeof context.languages === 'string'
            ? String(context.languages).split(',').map((s) => s.trim()).filter(Boolean)
            : undefined;
        const { candidates } = await this.subtitles.search(itemId, languages ? { languages } : {}, {});
        const best = candidates.find((c) => c.scoreTier === 'auto' || c.scoreTier === 'download');
        if (best) await this.subtitles.downloadCandidate(best.id, {});
        break;
      }
      default:
        this.logger.warn(`Unknown subtitle action "${type}"`);
    }
  }
}
