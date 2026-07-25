import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { statfs } from 'node:fs/promises';
import { DOMAIN_EVENTS } from '@ultratorrent/shared';
import { DomainEventBus } from '../domain-events/domain-event-bus.service';
import { EdgeDetector } from '../domain-events/edge-detector';

/** Free-space thresholds, as percentages. */
const WARNING_PERCENT = 15;
const CRITICAL_PERCENT = 5;

/**
 * Watches storage roots and publishes when one crosses a threshold.
 *
 * This restores the alerting the old health monitor provided — but as a
 * *publisher* rather than an owner: it emits domain events and holds no opinion
 * about who is told or how. The monitor it replaces reached straight into the
 * notification engine, which is why deleting notifications also deleted disk
 * alerts.
 *
 * **Edge-fired.** A full disk stays full; publishing on every tick would produce
 * a notification every few minutes about a condition the operator already knows
 * about, and the reliable outcome of that is a muted channel — taking the real
 * alerts with it.
 *
 * `bavail`, not `bfree`: the root-reserved blocks (5% by default on ext4) are
 * not space anything here can use, so counting them overstates free space and
 * makes the alert fire late — exactly when it matters least.
 */
@Injectable()
export class StorageWatchService {
  private readonly logger = new Logger(StorageWatchService.name);
  private readonly warning = new EdgeDetector();
  private readonly critical = new EdgeDetector();
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly bus: DomainEventBus,
  ) {}

  @Interval('storage_watch', 5 * 60_000)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.check();
    } catch (err) {
      // A watcher must never throw into the scheduler.
      this.logger.warn(`Storage check failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Check every configured root. Exposed for tests. */
  async check(): Promise<void> {
    const roots = this.config.get<string[]>('fileManager.roots') ?? [];
    // A root removed from the config should not keep state around forever.
    this.warning.retainOnly(roots);
    this.critical.retainOnly(roots);

    for (const path of roots) {
      let freePercent: number;
      try {
        const fs = await statfs(path);
        const total = fs.blocks * fs.bsize;
        if (!total) continue;
        freePercent = Math.round(((fs.bavail * fs.bsize) / total) * 100);
      } catch {
        // An unmounted or unreadable root is not a disk-space problem, and
        // guessing at one would be worse than staying quiet.
        continue;
      }

      const isCritical = freePercent <= CRITICAL_PERCENT;
      const isWarning = freePercent <= WARNING_PERCENT;

      const criticalEdge = this.critical.observe(path, isCritical);
      const warningEdge = this.warning.observe(path, isWarning);

      if (criticalEdge === 'rising') {
        this.publish(DOMAIN_EVENTS.SYSTEM_STORAGE_CRITICAL, path, freePercent);
        continue; // critical already says everything the warning would
      }
      // Only warn on the way in, and only when not already critical — otherwise a
      // disk recovering from 3% to 10% would announce a *new* warning.
      if (warningEdge === 'rising' && !isCritical) {
        this.publish(DOMAIN_EVENTS.SYSTEM_STORAGE_WARNING, path, freePercent);
        continue;
      }
      // Recovered means out of the warning band entirely, not merely out of
      // critical: telling someone "recovered" while still at 6% would be false.
      if (warningEdge === 'falling') {
        this.publish(DOMAIN_EVENTS.SYSTEM_STORAGE_RECOVERED, path, freePercent);
      }
    }
  }

  private publish(eventKey: string, path: string, freePercent: number): void {
    this.bus.publish({
      eventKey,
      resourceType: 'storage_root',
      resourceId: path,
      payload: { path, freePercent },
    });
  }
}
