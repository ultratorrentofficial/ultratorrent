import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MODULE_IDS } from '@ultratorrent/shared';
import { ModuleRegistryService } from '../../module-registry/module-registry.service';
import { HouseholdService } from './household.service';
import { HouseholdSettingsService } from './household-settings.service';

const TICK_MS = 60_000;
/** Subjects re-evaluated per tick — bounded so large installs are never hammered. */
const BATCH = 25;

/**
 * Household evaluation cadence. Reuses the existing durable session/watch-history
 * data (NO second poller): each tick recomputes a bounded batch of household
 * subjects and cycles through all of them, so historical backfill happens on its
 * own without the operator waiting weeks, and ongoing changes are reconciled. The
 * work is idempotent (a full recompute per subject), so it is safe to repeat.
 */
@Injectable()
export class HouseholdBackfillService {
  private readonly logger = new Logger(HouseholdBackfillService.name);
  private running = false;
  private cursor = 0;
  private keys: string[] = [];

  constructor(
    private readonly household: HouseholdService,
    private readonly settings: HouseholdSettingsService,
    private readonly registry: ModuleRegistryService,
  ) {}

  private get moduleEnabled(): boolean {
    return this.registry.getStatus(MODULE_IDS.MEDIA_SERVER_ANALYTICS)?.enabled ?? false;
  }

  @Interval('media_server_household_eval', TICK_MS)
  async tick(): Promise<void> {
    if (this.running || !this.moduleEnabled) return;
    this.running = true;
    try {
      const cfg = await this.settings.read();
      if (!cfg.enabled) return;
      // Refresh the working set when we have cycled through it.
      if (this.cursor === 0 || this.cursor >= this.keys.length) {
        this.keys = await this.household.allSubjectKeys();
        this.cursor = 0;
      }
      const batch = this.keys.slice(this.cursor, this.cursor + BATCH);
      this.cursor += BATCH;
      for (const key of batch) {
        try {
          await this.household.runFor(key);
        } catch (err) {
          this.logger.warn(`Household eval failed for ${key}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.warn(`Household backfill tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
