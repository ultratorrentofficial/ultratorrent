import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** Why a candidate cannot own or receive personal notifications. */
export type IneligibilityReason = 'not_found' | 'inactive';

export interface EligibilityResult {
  eligible: boolean;
  userId: string;
  reason?: IneligibilityReason;
}

/**
 * The single authority on who may own a notification profile, a channel connection,
 * an inbox, a preference or a delivery.
 *
 * **Only locally authenticated UltraTorrent users are eligible.** External identities
 * must never receive system notifications: `MediaServerUser` rows (Plex/Jellyfin/Emby
 * viewers synced from a server), Trakt links, API clients, service identities.
 *
 * Why a service rather than a column: the `User` table already contains *only* local
 * accounts — every row carries a `passwordHash` and there is no federated import path
 * into it — so adding an `origin` discriminator would be a redundant field that could
 * drift from reality. External identities live in their own tables with their own
 * keyspace (`MediaServerUser` is unique on `(connectionId, userName)` and has no
 * relation to `User`). Eligibility is therefore "is this id a live local account",
 * asked in exactly one place.
 *
 * What this deliberately does NOT do is infer eligibility from an email address, a
 * username, a media-server identity or playback history. A `MediaServerUser` can
 * carry the same email as a real account (Plex accounts have emails), so matching on
 * one would hand notifications to a viewer who cannot log in — the identity-confusion
 * defect this engine exists to remove.
 *
 * ⚠️ `User.isSystem` is NOT a service-account marker. It means "seeded account that
 * cannot be deleted" (`UsersService.remove()` refuses it), and the seeded admin is a
 * fully legitimate recipient. Filtering on it would silence the primary operator.
 */
@Injectable()
export class NotificationRecipientEligibilityService {
  private readonly logger = new Logger(NotificationRecipientEligibilityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Is this id a live local account? Fails closed: an id that resolves to nothing —
   * including any external identity, whose ids live in a different table entirely —
   * is ineligible.
   */
  async check(userId: string | null | undefined): Promise<EligibilityResult> {
    const id = (userId ?? '').trim();
    if (!id) return { eligible: false, userId: '', reason: 'not_found' };

    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    });
    if (!user) return { eligible: false, userId: id, reason: 'not_found' };
    if (!user.isActive) return { eligible: false, userId: id, reason: 'inactive' };
    return { eligible: true, userId: id };
  }

  async isEligible(userId: string | null | undefined): Promise<boolean> {
    return (await this.check(userId)).eligible;
  }

  /**
   * Narrow a candidate set to eligible users in ONE query.
   *
   * Audience resolution can produce hundreds of candidates, and checking them one at
   * a time would be an N+1 on the hottest path in the engine. Order is not preserved;
   * duplicates collapse, since the same person resolved twice (say as both actor and
   * resource owner) must not be notified twice.
   */
  async filterEligible(userIds: Array<string | null | undefined>): Promise<string[]> {
    const ids = [...new Set(userIds.map((u) => (u ?? '').trim()).filter(Boolean))];
    if (!ids.length) return [];
    const rows = await this.prisma.user.findMany({
      where: { id: { in: ids }, isActive: true },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Assert eligibility at a write/delivery boundary.
   *
   * Used by retry workers and delivery paths as well as controllers: an account can
   * be deactivated between a notification being queued and a retry firing, and
   * continuing to deliver to it would be exactly the "delivery after user
   * deactivation" failure this engine must not have.
   */
  async assertEligible(userId: string | null | undefined): Promise<string> {
    const result = await this.check(userId);
    if (!result.eligible) {
      this.logger.warn(`Rejected notification action for ineligible user "${result.userId}" (${result.reason}).`);
      throw new ForbiddenException('This account cannot receive notifications');
    }
    return result.userId;
  }

  /**
   * Assert that `resourceOwnerId` is the acting user — the ownership check that keeps
   * one person out of another's inbox, connections, preferences and deliveries.
   *
   * Kept beside eligibility on purpose: every self-service route needs *both*, and a
   * single call site for the pair is what stops one being remembered and the other
   * forgotten.
   */
  assertOwnership(actingUserId: string, resourceOwnerId: string | null | undefined): void {
    if (!resourceOwnerId || resourceOwnerId !== actingUserId) {
      this.logger.warn(
        `Blocked cross-user notification access: "${actingUserId}" → resource owned by "${resourceOwnerId ?? 'none'}".`,
      );
      // Deliberately the same response as a missing resource: distinguishing them
      // would confirm that another user's object exists.
      throw new ForbiddenException('Not found');
    }
  }
}
