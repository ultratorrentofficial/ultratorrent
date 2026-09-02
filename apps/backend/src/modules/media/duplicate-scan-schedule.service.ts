import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MediaDuplicateService } from './media-duplicate.service';

const KEY = 'media.duplicate_scan_schedule';

/** Every hour the ticker wakes; the interval below decides whether it acts. */
const TICK_MS = 60 * 60_000;

export const DUPLICATE_SCAN_INTERVALS = [6, 12, 24, 168] as const;
export type DuplicateScanIntervalHours = (typeof DUPLICATE_SCAN_INTERVALS)[number];

export interface DuplicateScanSchedule {
  enabled: boolean;
  /** 6h, 12h, daily, or weekly. */
  intervalHours: DuplicateScanIntervalHours;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

interface Stored {
  enabled?: boolean;
  intervalHours?: number;
  lastRunAt?: string;
}

/**
 * Run duplicate detection on a schedule.
 *
 * Detection had no trigger of its own: it ran only when someone opened the
 * Duplicates Center and pressed the button. Every other recurring job in the
 * system is driven — the activity scheduler sweeps every minute, the intake
 * reconciler hourly — so this was the one place where a real finding waited on
 * somebody remembering. Observed on a live host: two copies of the same film
 * sat ungrouped for two days, and were noticed only because a move failed.
 *
 * The cost of running it anyway is near zero. `detect()` takes a digest of its
 * input first and returns immediately when nothing has changed, so a scan on an
 * idle library is one query, not the 10.5s full pass.
 *
 * A fixed hourly tick that checks elapsed time, rather than a registered cron
 * per configured value: the schedule can be changed at runtime, and rewriting a
 * cron registration on every settings save is a great deal of machinery for a
 * job whose finest useful granularity is hours.
 */
@Injectable()
export class DuplicateScanScheduleService {
  private readonly logger = new Logger(DuplicateScanScheduleService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly duplicates: MediaDuplicateService,
  ) {}

  private async raw(): Promise<Stored> {
    const row = await this.prisma.setting.findUnique({ where: { key: KEY } });
    return (row?.value as Stored) ?? {};
  }

  private normalizeInterval(v: unknown): DuplicateScanIntervalHours {
    const n = Number(v);
    return (DUPLICATE_SCAN_INTERVALS as readonly number[]).includes(n)
      ? (n as DuplicateScanIntervalHours)
      : 24;
  }

  async get(): Promise<DuplicateScanSchedule> {
    const cfg = await this.raw();
    const intervalHours = this.normalizeInterval(cfg.intervalHours);
    const enabled = cfg.enabled ?? false;
    const lastRunAt = cfg.lastRunAt ?? null;
    return {
      enabled,
      intervalHours,
      lastRunAt,
      // Null when disabled: a "next run" on a schedule that will not fire is a
      // promise the system does not keep.
      nextRunAt:
        enabled && lastRunAt
          ? new Date(new Date(lastRunAt).getTime() + intervalHours * 3_600_000).toISOString()
          : null,
    };
  }

  async set(input: { enabled?: boolean; intervalHours?: number }): Promise<DuplicateScanSchedule> {
    const cur = await this.raw();
    const next: Stored = {
      ...cur,
      enabled: input.enabled ?? cur.enabled ?? false,
      intervalHours: this.normalizeInterval(input.intervalHours ?? cur.intervalHours),
    };
    await this.prisma.setting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: next as object },
      update: { value: next as object },
    });
    return this.get();
  }

  /** Record a run — also called after a manual scan, so the clock is honest. */
  async markRan(at: Date = new Date()): Promise<void> {
    const cur = await this.raw();
    const next: Stored = { ...cur, lastRunAt: at.toISOString() };
    await this.prisma.setting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: next as object },
      update: { value: next as object },
    });
  }

  @Interval('duplicate_scan_schedule', TICK_MS)
  async tick(): Promise<boolean> {
    if (this.running) return false;
    const cfg = await this.get();
    if (!cfg.enabled) return false;
    if (cfg.nextRunAt && new Date(cfg.nextRunAt).getTime() > Date.now()) return false;

    this.running = true;
    try {
      const started = Date.now();
      await this.duplicates.detect();
      await this.markRan();
      this.logger.log(`Scheduled duplicate detection finished in ${Date.now() - started}ms`);
      return true;
    } catch (err) {
      // Never rethrow from a ticker: an unhandled rejection here would take the
      // interval down and silently end the schedule.
      this.logger.warn(`Scheduled duplicate detection failed: ${(err as Error).message}`);
      return false;
    } finally {
      this.running = false;
    }
  }
}
