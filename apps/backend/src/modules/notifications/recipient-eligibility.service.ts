import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * The single authority on who may own a notification.
 *
 * **Only a locally authenticated UltraTorrent user.** Plex/Jellyfin/Emby
 * viewers, Trakt links, API clients and imported playback identities must never
 * own an inbox, a preference or a channel connection.
 *
 * Two rules make that hold, and both matter:
 *
 * 1. **Look up by primary key only.** Never by email or username. A media-server
 *    account legitimately shares an operator's email address, so matching on it
 *    would let an external identity resolve to a local account — the exact
 *    confusion that made the old engine unsafe, where a Plex user id was read
 *    from the same payload field as a local user id.
 * 2. **Fail closed.** An id that does not resolve to an active local user is not
 *    eligible. There is no fallback, no "notify the admin instead".
 *
 * `User.isSystem` is deliberately **not** a filter. It means "seeded and
 * undeletable", not "service identity" — the bootstrap admin is `isSystem`, and
 * excluding it would silence the one account guaranteed to exist.
 */
@Injectable()
export class NotificationRecipientEligibilityService {
  constructor(private readonly prisma: PrismaService) {}

  /** Is this id an active local user? */
  async isEligible(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isActive: true },
    });
    return !!user?.isActive;
  }

  /**
   * Narrow a candidate list to eligible users, in one query.
   *
   * Batched because the audience path resolves many ids at once and an N+1 there
   * would put a query per candidate on the dispatch of every event.
   */
  async filterEligible(userIds: readonly string[]): Promise<string[]> {
    const unique = [...new Set(userIds.filter(Boolean))];
    if (!unique.length) return [];
    const rows = await this.prisma.user.findMany({
      where: { id: { in: unique }, isActive: true },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Assert a user may act, at request time.
   *
   * Called per request rather than trusted from the token: an account can be
   * deactivated while a session is still alive, and a deactivated account must
   * not keep editing preferences for notifications it will never receive.
   */
  async assertEligible(userId: string): Promise<void> {
    if (!(await this.isEligible(userId))) {
      throw new Error('Not an eligible notification recipient.');
    }
  }
}
