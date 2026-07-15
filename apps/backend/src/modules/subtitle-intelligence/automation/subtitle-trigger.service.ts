/**
 * Fires Subtitle Intelligence automation triggers, best-effort. Centralizes the
 * lazy `AutomationEngine` lookup (via ModuleRef, `strict: false`) in one place so
 * no subtitle service takes a hard dependency on the automation module — the same
 * decoupling the media module uses to avoid an import cycle.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AutomationEngine } from '../../automation/automation.module';

@Injectable()
export class SubtitleTriggerService {
  private readonly logger = new Logger(SubtitleTriggerService.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  /** Evaluate `trigger` with the given context. Never throws into the caller. */
  fire(trigger: string, context: Record<string, unknown>): void {
    try {
      this.moduleRef
        .get(AutomationEngine, { strict: false })
        .evaluateEvent(trigger, context)
        .catch((err) => this.logger.warn(`${trigger} evaluation failed: ${(err as Error).message}`));
    } catch (err) {
      // Engine not resolvable (e.g. during teardown) — automation is optional.
      this.logger.warn(`Could not fire ${trigger}: ${(err as Error).message}`);
    }
  }
}
