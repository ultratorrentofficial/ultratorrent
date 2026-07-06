import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.module';
import { TvShowStatusService } from './tv-show-status.service';

/** RSS action ids dispatched here by the AutomationEngine. */
export const RSS_ACTION_TYPES = new Set([
  'refresh_rss_show_status',
  'disable_rss_rule',
  'convert_rule_to_backfill',
]);

/**
 * Executes the RSS show-status automation actions dispatched by the
 * AutomationEngine. Kept free of any AutomationEngine dependency so the engine
 * can inject it without a circular reference (the engine depends on this; this
 * depends on RSS/Prisma only — the engine is reached from RSS lazily via
 * ModuleRef when *firing* triggers).
 *
 * Rule targeting: an explicit `params.ruleId` wins; otherwise the action falls
 * back to the show identity carried on the trigger context
 * (`provider` + `providerShowId`) and applies to every rule snapshotting it.
 */
@Injectable()
export class RssAutomationActions {
  private readonly logger = new Logger(RssAutomationActions.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly showStatus: TvShowStatusService,
    private readonly notifications: NotificationsService,
  ) {}

  async execute(
    type: string,
    params: Record<string, unknown> = {},
    context: Record<string, unknown> = {},
  ): Promise<unknown> {
    switch (type) {
      case 'refresh_rss_show_status': {
        const provider = this.str(params.provider ?? context.provider);
        const providerShowId = this.str(params.providerShowId ?? context.providerShowId);
        if (!provider || !providerShowId) {
          throw new BadRequestException(
            'refresh_rss_show_status needs provider + providerShowId (from params or trigger context)',
          );
        }
        return this.showStatus.resolveByProviderId(provider, providerShowId, true);
      }
      case 'disable_rss_rule': {
        const where = await this.ruleWhere(params, context);
        const res = await this.prisma.rssRule.updateMany({
          where,
          data: { isEnabled: false },
        });
        this.logger.log(`disable_rss_rule: disabled ${res.count} rule(s)`);
        return { disabled: res.count };
      }
      case 'convert_rule_to_backfill': {
        // "Backfill only" = stop forward auto-grabbing but keep the rule so past
        // episodes can still be matched/upgraded manually.
        const where = await this.ruleWhere(params, context);
        const res = await this.prisma.rssRule.updateMany({
          where,
          data: { autoDownload: false },
        });
        this.logger.log(`convert_rule_to_backfill: converted ${res.count} rule(s)`);
        return { converted: res.count };
      }
      default:
        throw new BadRequestException(`Unknown RSS action type: ${type}`);
    }
  }

  /** Build the rule filter from an explicit id or the show identity on context. */
  private async ruleWhere(
    params: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<{ id: string } | { showStatusProvider: string; showStatusProviderId: string }> {
    const ruleId = this.str(params.ruleId);
    if (ruleId) return { id: ruleId };
    const provider = this.str(params.provider ?? context.provider);
    const providerShowId = this.str(params.providerShowId ?? context.providerShowId);
    if (provider && providerShowId) {
      return { showStatusProvider: provider, showStatusProviderId: providerShowId };
    }
    throw new BadRequestException(
      'RSS rule action needs a ruleId, or provider + providerShowId on the trigger context',
    );
  }

  private str(v: unknown): string | null {
    return typeof v === 'string' && v.length > 0 ? v : null;
  }
}
