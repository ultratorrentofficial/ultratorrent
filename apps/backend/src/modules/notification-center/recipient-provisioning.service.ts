import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** What one reconcile pass changed. */
export interface ProvisioningSummary {
  created: number;
  adopted: number;
  updated: number;
  disabled: number;
}

/**
 * Keeps the notification recipient list in step with the platform's users.
 *
 * A recipient used to be an island: a hand-made row whose `userId` nothing ever
 * populated. On a live install that produced exactly the trap it looks like — a
 * recipient "Dennis Ayala" carrying the admin's own email address, with `userId`
 * null, so nothing connected the person receiving mail to the account that logs in.
 * Every per-user feature (a routing profile above all) needs that link to exist.
 *
 * Reconciliation is deliberately IDEMPOTENT and runs at boot, so an install that
 * predates this service converges without anyone being asked to press anything, and a
 * user created while the app was down is picked up on the next start.
 *
 * External recipients are preserved. A row with a null `userId` that matches no user
 * is somebody without an account — an on-call alias, a family member — and deleting
 * it would silently stop mail the operator deliberately configured.
 */
@Injectable()
export class RecipientProvisioningService implements OnModuleInit {
  private readonly logger = new Logger(RecipientProvisioningService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      const s = await this.reconcile();
      if (s.created || s.adopted || s.updated || s.disabled) {
        this.logger.log(
          `Recipients reconciled with users: ${s.created} created, ${s.adopted} adopted, ` +
            `${s.updated} updated, ${s.disabled} disabled.`,
        );
      }
    } catch (err) {
      // Never block bootstrap on this — a notification list that is one user stale is
      // survivable; a backend that will not boot is not.
      this.logger.warn(`Recipient reconciliation skipped: ${(err as Error).message}`);
    }
  }

  /**
   * Make the recipient list reflect the users table.
   *
   * - a user with no recipient gets one;
   * - an **unlinked recipient whose email matches a user is adopted**, not duplicated
   *   — the alternative leaves two rows for one human, and the operator's existing
   *   Telegram chat id sits on the row that is about to be ignored;
   * - a linked recipient follows its user's display name, email and active state;
   * - a recipient whose user is gone or deactivated is DISABLED, never deleted, so its
   *   routing profile and delivery history survive a temporary deactivation.
   */
  async reconcile(): Promise<ProvisioningSummary> {
    const summary: ProvisioningSummary = { created: 0, adopted: 0, updated: 0, disabled: 0 };
    const users = await this.prisma.user.findMany({
      select: { id: true, username: true, email: true, displayName: true, isActive: true },
    });
    const recipients = await this.prisma.notificationRecipient.findMany();
    const byUserId = new Map(recipients.filter((r) => r.userId).map((r) => [r.userId as string, r]));

    for (const user of users) {
      const name = user.displayName?.trim() || user.username;
      const linked = byUserId.get(user.id);

      if (!linked) {
        // Adopt an existing unlinked row that is plainly the same person before
        // creating a second one. Email is the only identifier the two models share.
        const orphan = user.email
          ? recipients.find(
              (r) => !r.userId && r.email && r.email.toLowerCase() === user.email!.toLowerCase(),
            )
          : undefined;
        if (orphan) {
          await this.prisma.notificationRecipient.update({
            where: { id: orphan.id },
            data: { userId: user.id, displayName: name, enabled: user.isActive },
          });
          summary.adopted += 1;
          this.logger.log(`Adopted recipient "${orphan.displayName}" into user "${user.username}".`);
          continue;
        }
        await this.prisma.notificationRecipient.create({
          data: { userId: user.id, displayName: name, email: user.email ?? null, enabled: user.isActive },
        });
        summary.created += 1;
        continue;
      }

      const needsUpdate =
        linked.displayName !== name ||
        (user.email ?? null) !== (linked.email ?? null) ||
        linked.enabled !== user.isActive;
      if (needsUpdate) {
        await this.prisma.notificationRecipient.update({
          where: { id: linked.id },
          data: { displayName: name, email: user.email ?? null, enabled: user.isActive },
        });
        summary.updated += 1;
      }
    }

    // A recipient still pointing at a user that no longer exists.
    const userIds = new Set(users.map((u) => u.id));
    for (const r of recipients) {
      if (r.userId && !userIds.has(r.userId) && r.enabled) {
        await this.prisma.notificationRecipient.update({ where: { id: r.id }, data: { enabled: false } });
        summary.disabled += 1;
      }
    }

    return summary;
  }
}
