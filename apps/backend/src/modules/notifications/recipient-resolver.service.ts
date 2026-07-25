import { Injectable, Logger } from '@nestjs/common';
import { SystemRole, type DomainEventEnvelope, type NotificationEventDefinition } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { NotificationRecipientEligibilityService } from './recipient-eligibility.service';

/**
 * Turns one event into the set of local users who should hear about it.
 *
 * The strategy is fixed per event **in code**. There is no audience designer,
 * because the previous one is how a notification ended up broadcast to everyone.
 *
 * Two orderings are load-bearing:
 *
 * - **Eligibility before permissions.** A candidate id may come from a payload
 *   that also carries media-server user ids. Checking eligibility first means a
 *   foreign-namespace id is discarded before it is ever looked up in the
 *   permission tables, so it cannot accidentally match a local account.
 * - **Fail closed.** An unresolvable audience reaches nobody. Never "fall back to
 *   the administrators" — that is how personal events leak.
 */
@Injectable()
export class NotificationRecipientResolver {
  private readonly logger = new Logger(NotificationRecipientResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: NotificationRecipientEligibilityService,
  ) {}

  async resolve(
    definition: NotificationEventDefinition,
    envelope: DomainEventEnvelope,
  ): Promise<string[]> {
    switch (definition.recipientStrategy) {
      case 'affected_user':
        return this.affectedUser(envelope);

      case 'resource_owner':
        return this.resourceOwner(definition, envelope);

      case 'permission_holders':
        if (!definition.requiredPermission) {
          // A permission-gated event with no permission would resolve to
          // everyone. Refuse rather than over-deliver.
          this.logger.warn(`"${definition.key}" is permission_holders with no requiredPermission`);
          return [];
        }
        return this.usersWithPermission(definition.requiredPermission);

      case 'administrators':
        return this.administrators();

      default:
        return [];
    }
  }

  /**
   * The person the event is about.
   *
   * `subjectUserId` first, then `actorUserId`: for "your password changed" the
   * subject is the account owner even when an admin performed the change, and
   * telling the admin instead of the owner would be exactly backwards.
   */
  private async affectedUser(envelope: DomainEventEnvelope): Promise<string[]> {
    const candidate = envelope.subjectUserId ?? envelope.actorUserId;
    return this.eligibility.filterEligible(candidate ? [candidate] : []);
  }

  /**
   * Whoever owns the resource, else everyone who can see resources of that kind.
   *
   * The fallback is not a widening of scope: `requiredPermission` still gates it,
   * so "everyone" means "everyone already allowed to see this". Torrents carry no
   * owner column today, so this is the fallback path in practice.
   */
  private async resourceOwner(
    definition: NotificationEventDefinition,
    envelope: DomainEventEnvelope,
  ): Promise<string[]> {
    const owner = envelope.subjectUserId ?? envelope.actorUserId;
    if (owner) {
      const eligible = await this.eligibility.filterEligible([owner]);
      if (eligible.length) return eligible;
    }
    if (!definition.requiredPermission) return [];
    return this.usersWithPermission(definition.requiredPermission);
  }

  /**
   * Active local users holding a permission.
   *
   * `SUPER_ADMIN` is matched by role, not by stored rows: the guard grants it
   * everything implicitly, so a permission-row query would miss the one account
   * guaranteed to be able to act.
   */
  private async usersWithPermission(permission: string): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: {
        isActive: true,
        roles: {
          some: {
            role: {
              OR: [
                { name: SystemRole.SUPER_ADMIN },
                { permissions: { some: { permission: { key: permission } } } },
              ],
            },
          },
        },
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  private async administrators(): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: {
        isActive: true,
        roles: { some: { role: { name: { in: [SystemRole.SUPER_ADMIN, SystemRole.ADMINISTRATOR] } } } },
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
