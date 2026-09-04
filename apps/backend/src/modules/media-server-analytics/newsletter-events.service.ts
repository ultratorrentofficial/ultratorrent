import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** What can happen to a newsletter. */
export type NewsletterEventType =
  | 'generated'
  | 'send_started'
  | 'recipient_sent'
  | 'recipient_failed'
  | 'send_completed'
  | 'send_failed'
  | 'schedule_skipped'
  | 'test_sent'
  | 'unsubscribed'
  /** Entries held back from an issue because they had no artwork or metadata. */
  | 'items_withheld'
  /** Entries carried forward past the deferral window and given up on. */
  | 'items_abandoned'
  /** Entries published with a gap that does not stop them (no runtime, no rating). */
  | 'items_incomplete';

export type NewsletterEventLevel = 'info' | 'success' | 'warning' | 'error';

export interface RecordEvent {
  newsletterId?: string | null;
  runId?: string | null;
  level: NewsletterEventLevel;
  eventType: NewsletterEventType;
  messageKey?: string;
  messageParams?: Record<string, unknown>;
  sanitizedMessage?: string;
  metadata?: Record<string, unknown>;
}

/** How many events one newsletter keeps. */
const RETAIN_PER_NEWSLETTER = 500;

/**
 * Records what happened to a newsletter, for an operator to read afterwards.
 *
 * Distinct from the audit log on purpose. Audit answers "who did what" and is
 * written per USER action; most of what matters here has no user behind it —
 * a scheduled dispatch, an SMTP refusal for one recipient, a generation that
 * found nothing to send. Those are precisely what somebody is looking for when
 * a newsletter did not arrive, and an audit trail is the wrong place to keep
 * them.
 */
@Injectable()
export class NewsletterEventsService {
  private readonly logger = new Logger(NewsletterEventsService.name);
  /** Per-run counter, so events within a run order correctly. */
  private readonly sequences = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  /** Start a run and get its id. */
  newRun(): string {
    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.sequences.set(runId, 0);
    return runId;
  }

  /**
   * Record one event.
   *
   * Never throws. A newsletter that sent correctly must not be reported as
   * failed because the note about it could not be written, and a newsletter
   * that failed must still fail for its own reason rather than this one.
   */
  async record(event: RecordEvent): Promise<void> {
    try {
      const runId = event.runId ?? null;
      let sequence = 0;
      if (runId) {
        sequence = (this.sequences.get(runId) ?? 0) + 1;
        this.sequences.set(runId, sequence);
      }
      await this.prisma.mediaServerNewsletterEvent.create({
        data: {
          newsletterId: event.newsletterId ?? null,
          runId,
          sequence,
          level: event.level,
          eventType: event.eventType,
          messageKey: event.messageKey ?? null,
          messageParams: (event.messageParams ?? undefined) as never,
          sanitizedMessage: event.sanitizedMessage ?? null,
          metadata: (event.metadata ?? undefined) as never,
        },
      });
    } catch (err) {
      this.logger.warn(`Could not record newsletter event: ${(err as Error).message}`);
    }
  }

  /**
   * The activity feed: one entry per run, plus anything that had no run.
   *
   * A send writes one event per recipient, so a feed of raw events would be two
   * hundred lines saying the same thing. The run's OUTCOME leads the entry and
   * the rest hang under it — which is exactly the shape the activity viewer
   * already renders, so the expanded rows come out looking like every other
   * expanded row in the product.
   */
  async activity(newsletterId?: string, limit = 50): Promise<NewsletterActivityEntry[]> {
    const rows = await this.prisma.mediaServerNewsletterEvent.findMany({
      where: newsletterId ? { newsletterId } : {},
      orderBy: { createdAt: 'desc' },
      // Generous, because one run collapses into a single entry: fetching only
      // `limit` rows would return a handful of entries after grouping.
      take: Math.min(limit * 40, 2000),
    });

    const shape = (r: (typeof rows)[number]) => ({
      id: r.id,
      newsletterId: r.newsletterId,
      runId: r.runId,
      level: r.level as NewsletterEventLevel,
      eventType: r.eventType as NewsletterEventType,
      messageKey: r.messageKey,
      messageParams: (r.messageParams ?? null) as Record<string, unknown> | null,
      sanitizedMessage: r.sanitizedMessage,
      metadata: (r.metadata ?? null) as Record<string, unknown> | null,
      createdAt: r.createdAt,
    });

    const runs = new Map<string, typeof rows>();
    const standalone: typeof rows = [];
    for (const row of rows) {
      if (!row.runId) {
        standalone.push(row);
        continue;
      }
      const list = runs.get(row.runId) ?? [];
      list.push(row);
      runs.set(row.runId, list);
    }

    const entries: NewsletterActivityEntry[] = [];
    for (const [runId, list] of runs) {
      // Oldest first inside the run: it reads as a sequence of what happened.
      const ordered = [...list].sort((a, b) => a.sequence - b.sequence);
      // The entry is the run's conclusion when it has one, else its last event —
      // an interrupted run still has to appear, and appear as itself.
      const head =
        ordered.find((r) => r.eventType === 'send_completed' || r.eventType === 'send_failed') ??
        ordered[ordered.length - 1];
      entries.push({
        ...shape(head),
        runId,
        events: ordered.filter((r) => r.id !== head.id).map(shape),
      });
    }
    for (const row of standalone) {
      entries.push({ ...shape(row), events: [] });
    }

    entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return entries.slice(0, limit);
  }

  /** Forget a finished run's counter, so the map cannot grow without bound. */
  endRun(runId: string): void {
    this.sequences.delete(runId);
  }

  /**
   * Trim a newsletter's history.
   *
   * A weekly newsletter to two hundred recipients writes two hundred events per
   * send; without a cap the table grows forever for a feature nobody reads
   * beyond the last few sends.
   */
  async prune(newsletterId: string): Promise<void> {
    try {
      const keep = await this.prisma.mediaServerNewsletterEvent.findMany({
        where: { newsletterId },
        orderBy: { createdAt: 'desc' },
        take: RETAIN_PER_NEWSLETTER,
        select: { id: true },
      });
      if (keep.length < RETAIN_PER_NEWSLETTER) return;
      await this.prisma.mediaServerNewsletterEvent.deleteMany({
        where: { newsletterId, id: { notIn: keep.map((k) => k.id) } },
      });
    } catch (err) {
      this.logger.warn(`Could not prune newsletter events: ${(err as Error).message}`);
    }
  }
}

/** One entry in the activity view, with the events it stands for. */
export interface NewsletterActivityEntry {
  id: string;
  newsletterId: string | null;
  runId: string | null;
  level: NewsletterEventLevel;
  eventType: NewsletterEventType;
  messageKey: string | null;
  messageParams: Record<string, unknown> | null;
  sanitizedMessage: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  /** The rest of the run, oldest first. Empty for a standalone event. */
  events: Omit<NewsletterActivityEntry, 'events'>[];
}
