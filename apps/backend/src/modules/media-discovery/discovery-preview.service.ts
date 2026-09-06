import { Injectable } from '@nestjs/common';
import type { DiscoveryDecision } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { evaluateDiscovery, type PolicyTemplate, type PolicyVerdict } from './discovery-policy';

/**
 * What a template WOULD do, without doing any of it.
 *
 * Preview runs `evaluateDiscovery` — the same function the real evaluation runs,
 * not a reimplementation of it — over the catalogue already in the database and
 * reports the verdicts. That is the entire reason the evaluator was written pure:
 * a preview built from a second copy of the rules would drift from them, and the
 * drift would be invisible precisely where confidence matters most.
 *
 * **This service writes nothing.** No watchlist entry, no rule, no directory, no
 * evaluation row, no counter. It reads `discovered_media` and returns numbers. A
 * test asserts that by handing it a Prisma stub whose every write method throws.
 */

/** Rows one preview will examine. Beyond this the answer is a projection. */
const MAX_EXAMINED = 5_000;
/** Titles returned per decision, so a preview response stays a response. */
const SAMPLES_PER_DECISION = 25;

export interface PreviewSample {
  discoveredMediaId: string;
  title: string;
  year: number | null;
  genres: string[];
  decision: DiscoveryDecision;
  reason: string;
}

export interface PreviewResult {
  /** Titles the evaluator was run over. */
  examined: number;
  /**
   * True when the catalogue is larger than one preview may read. The counts are
   * then a sample rather than a census, and say so rather than quietly rounding.
   */
  truncated: boolean;
  counts: Record<DiscoveryDecision | 'not_applicable', number>;
  /**
   * How the automatic-add limits would bite.
   *
   * Reported, not applied: this is a projection so an operator can see the shape
   * of the first run before enabling anything. Enforcement lives with the
   * evaluation, not here.
   */
  limits: {
    perDay: number;
    perWeek: number;
    autoMonitorCandidates: number;
    /** Candidates beyond the weekly allowance, which would be held for review. */
    beyondWeeklyAllowance: number;
  };
  samples: PreviewSample[];
  generatedAt: string;
}

/** A template as preview needs it — saved or not, so the adjust loop works. */
export interface PreviewableTemplate extends PolicyTemplate {
  autoAddLimitPerDay: number;
  autoAddLimitPerWeek: number;
}

@Injectable()
export class DiscoveryPreviewService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Evaluate the stored catalogue against a template.
   *
   * The template is passed by VALUE rather than by id so an unsaved one can be
   * previewed — the adjust-preview-adjust loop is the point of the feature, and
   * requiring a save first would mean persisting configurations an operator is
   * still arguing with.
   */
  async preview(template: PreviewableTemplate, now = new Date()): Promise<PreviewResult> {
    const rows = await this.prisma.discoveredMedia.findMany({
      // One more than the cap, purely to detect that there was more.
      take: MAX_EXAMINED + 1,
      orderBy: { lastSeenAt: 'desc' },
      include: { releaseDates: true },
    });

    const truncated = rows.length > MAX_EXAMINED;
    const examinable = truncated ? rows.slice(0, MAX_EXAMINED) : rows;

    const counts: PreviewResult['counts'] = {
      auto_monitor: 0,
      notify: 0,
      ignore: 0,
      needs_review: 0,
      not_applicable: 0,
    };
    const samples: PreviewSample[] = [];
    const sampled: Record<string, number> = {};

    for (const row of examinable) {
      const verdict = this.evaluate(row, template, now);
      const key = verdict.applies ? verdict.decision : 'not_applicable';
      counts[key] += 1;

      /*
       * Samples are capped PER DECISION rather than overall. A catalogue where
       * 90% is ignored would otherwise fill the whole sample with ignores and
       * show none of the handful of titles that would actually be monitored —
       * which are the ones an operator opened the preview to see.
       */
      if (verdict.applies && (sampled[key] ?? 0) < SAMPLES_PER_DECISION) {
        sampled[key] = (sampled[key] ?? 0) + 1;
        samples.push({
          discoveredMediaId: row.id,
          title: row.title,
          year: row.year,
          genres: row.genres,
          decision: verdict.decision,
          reason: verdict.reason,
        });
      }
    }

    return {
      examined: examinable.length,
      truncated,
      counts,
      limits: {
        perDay: template.autoAddLimitPerDay,
        perWeek: template.autoAddLimitPerWeek,
        autoMonitorCandidates: counts.auto_monitor,
        beyondWeeklyAllowance: Math.max(0, counts.auto_monitor - template.autoAddLimitPerWeek),
      },
      samples,
      generatedAt: now.toISOString(),
    };
  }

  /** One row through the same evaluator the real run uses. */
  private evaluate(row: PreviewRow, template: PolicyTemplate, now: Date): PolicyVerdict {
    return evaluateDiscovery(
      {
        mediaType: row.mediaType,
        title: row.title,
        genres: row.genres,
        originalLanguage: row.originalLanguage,
        countries: row.countries,
        network: row.network,
        streamingService: row.streamingService,
        studio: row.studio,
        popularity: row.popularity,
        rating: row.rating,
        voteCount: row.voteCount,
        identityStatus: row.identityStatus,
        confidence: row.confidence,
        releaseDates: row.releaseDates.map((d) => ({
          releaseType: d.releaseType,
          date: d.date ? d.date.toISOString().slice(0, 10) : null,
          region: d.region,
        })),
      },
      template,
      {
        now,
        /*
         * Deliberately false.
         *
         * A preview answers "what does this template select", and a budget is
         * about pacing rather than selection. Folding it in would make every
         * title past the tenth read as `needs_review` and hide the shape of the
         * policy an operator is actually tuning. The projection in `limits` says
         * what the cap would do, separately and legibly.
         */
        autoAddBudgetExhausted: false,
      },
    );
  }
}

interface PreviewRow {
  id: string;
  mediaType: string;
  title: string;
  year: number | null;
  genres: string[];
  originalLanguage: string | null;
  countries: string[];
  network: string | null;
  streamingService: string | null;
  studio: string | null;
  popularity: number | null;
  rating: number | null;
  voteCount: number | null;
  identityStatus: string;
  confidence: number;
  releaseDates: Array<{ releaseType: string; date: Date | null; region: string | null }>;
}
