import { Injectable, Logger } from '@nestjs/common';
import { SystemRole } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { NotificationRecipientEligibilityService } from '../recipient-eligibility.service';
import { getEventDefinition, validateEventPayload } from './notification-catalog';

/** The domain event as it arrives on the bus, normalized for resolution. */
export interface ResolvableEvent {
  eventKey: string;
  payload: Record<string, unknown>;
  /** Local user id who caused it, when there is one. */
  actorUserId?: string | null;
  /** Local user the event is *about* (password changed, API key created). */
  subjectUserId?: string | null;
  /** Local user who owns the resource (workflow owner, plan creator). */
  resourceOwnerUserId?: string | null;
  /** Explicit local user ids — validated, never trusted as given. */
  explicitRecipientUserIds?: string[];
}

export interface AudienceResolution {
  /** Local user ids that survived every filter. */
  userIds: string[];
  /** Why the event reached nobody, when it did not. */
  reason?: 'unregistered_event' | 'invalid_payload' | 'empty_audience' | 'no_eligible' | 'no_permitted';
  /** Counts for observability — how many were dropped and at which stage. */
  stats: { candidates: number; eligible: number; permitted: number };
}

/**
 * Resolves who should be told about an event.
 *
 * The old engine answered this with a static recipient list on a rule, with no
 * permission check and no notion of local identity. This replaces it with the
 * intersection the brief requires:
 *
 *   event audience ∩ eligible local users ∩ active ∩ RBAC permission
 *
 * Resource-level authorization is applied by the caller where a resource exists;
 * this layer covers the parts that are uniform across every event.
 *
 * **Fail closed.** An unregistered event, an invalid payload, or an audience that
 * resolves to nothing reaches nobody — never everybody. That direction matters: the
 * failure mode of a broadcast system is telling the wrong people, and it is the one
 * mistake a notification engine cannot take back.
 *
 * Note this resolves *candidates*, not deliveries: a user who is eligible and
 * permitted still receives nothing unless their own preference enables the event.
 * Personal preference is applied downstream (Phase 4), so `administrators` here means
 * "administrators who may see it", never "administrators will be messaged".
 */
@Injectable()
export class NotificationAudienceResolver {
  private readonly logger = new Logger(NotificationAudienceResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: NotificationRecipientEligibilityService,
  ) {}

  async resolve(event: ResolvableEvent): Promise<AudienceResolution> {
    const empty = (reason: AudienceResolution['reason']): AudienceResolution => ({
      userIds: [],
      reason,
      stats: { candidates: 0, eligible: 0, permitted: 0 },
    });

    const def = getEventDefinition(event.eventKey);
    if (!def) {
      this.logger.warn(`Refusing to dispatch unregistered event "${event.eventKey}".`);
      return empty('unregistered_event');
    }
    const payloadCheck = validateEventPayload(event.eventKey, event.payload);
    if (!payloadCheck.valid) {
      this.logger.warn(
        `Refusing to dispatch "${event.eventKey}": ${payloadCheck.reason}` +
          (payloadCheck.missing?.length ? ` (${payloadCheck.missing.join(', ')})` : ''),
      );
      return empty('invalid_payload');
    }

    const candidates = await this.candidatesFor(def.audience, def.requiredPermission, event);
    if (!candidates.length) return empty('empty_audience');

    // Eligibility BEFORE permission: an id from another identity namespace (a Plex
    // viewer) must never even be looked up in the permission tables.
    const eligible = await this.eligibility.filterEligible(candidates);
    if (!eligible.length) {
      return { userIds: [], reason: 'no_eligible', stats: { candidates: candidates.length, eligible: 0, permitted: 0 } };
    }

    const permitted = def.requiredPermission
      ? await this.filterByPermission(eligible, def.requiredPermission)
      : eligible;

    return {
      userIds: permitted,
      reason: permitted.length ? undefined : 'no_permitted',
      stats: { candidates: candidates.length, eligible: eligible.length, permitted: permitted.length },
    };
  }

  /** Candidate local user ids for an audience, before eligibility or RBAC. */
  private async candidatesFor(
    audience: string,
    requiredPermission: string | undefined,
    event: ResolvableEvent,
  ): Promise<string[]> {
    switch (audience) {
      case 'actor':
        return [event.actorUserId ?? ''].filter(Boolean) as string[];
      case 'subject_user':
        return [event.subjectUserId ?? ''].filter(Boolean) as string[];
      case 'resource_owner':
        // Owner and requester both matter for a failed run: the person who built it
        // and the person who set it going are rarely the same.
        return [event.resourceOwnerUserId ?? '', event.actorUserId ?? ''].filter(Boolean) as string[];
      case 'requester':
        return [event.actorUserId ?? ''].filter(Boolean) as string[];
      case 'explicit_users':
        return event.explicitRecipientUserIds ?? [];
      case 'approvers':
      case 'permission_holders':
        // Who may act on it *is* the audience — derived from the permission the
        // event declares, so a new role automatically resolves correctly.
        return requiredPermission ? this.usersWithPermission(requiredPermission) : [];
      case 'administrators':
        return this.usersWithRole([SystemRole.SUPER_ADMIN, SystemRole.ADMINISTRATOR]);
      case 'role_members':
        return this.usersWithRole([SystemRole.SUPER_ADMIN, SystemRole.ADMINISTRATOR]);
      case 'all_eligible_system_users': {
        const rows = await this.prisma.user.findMany({ where: { isActive: true }, select: { id: true } });
        return rows.map((r) => r.id);
      }
      default:
        // An unknown audience is a programming error; reaching nobody is the safe
        // reading of it.
        this.logger.warn(`Unknown audience "${audience}" — resolving to nobody.`);
        return [];
    }
  }

  /**
   * Narrow to users holding a permission, in ONE query.
   *
   * SUPER_ADMIN holds everything implicitly (the guard enforces that rather than the
   * role's stored rows), so it is matched by role instead of by permission — leaving
   * it out would quietly exclude the one account guaranteed to be able to act.
   */
  private async filterByPermission(userIds: string[], permission: string): Promise<string[]> {
    if (!userIds.length) return [];
    const rows = await this.prisma.user.findMany({
      where: {
        id: { in: userIds },
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

  private async usersWithRole(roleNames: string[]): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: { isActive: true, roles: { some: { role: { name: { in: roleNames } } } } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
