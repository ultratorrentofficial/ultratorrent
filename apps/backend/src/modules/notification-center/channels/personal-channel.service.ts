import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import type { ConnectionBackedChannelType, NotificationChannelHealth } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { SecretCipher } from '../../../common/crypto/secret-cipher';
import {
  secretFieldFor,
  validatePersonalChannelConfig,
} from './personal-channel-validators';
import type { PersonalChannelView } from './personal-channel.types';

/** How many consecutive failures before a connection reads as failing. */
const FAILING_THRESHOLD = 3;
/** A Telegram linking code is short-lived by design. */
const LINK_CODE_TTL_MS = 10 * 60_000;

interface PendingLink {
  userId: string;
  name: string;
  /** Hashed, never stored raw — a leaked store must not yield usable codes. */
  codeHash: string;
  expiresAt: number;
}

/**
 * Personal channel connections: create, verify, test, revoke.
 *
 * Every connection belongs to exactly one eligible user, and **every query in this
 * service is scoped by `userId`**. There is no method that can read or mutate another
 * person's connection, and a foreign id is reported as "not found" rather than
 * "forbidden" so a response cannot confirm that someone else's connection exists.
 *
 * Config is encrypted at rest with the platform's AES-GCM cipher and is **never**
 * returned by any read path. Listings render from `destinationMask`, computed once on
 * write, so the common case never decrypts at all.
 */
@Injectable()
export class PersonalChannelService {
  private readonly logger = new Logger(PersonalChannelService.name);
  /**
   * Pending Telegram links, in memory.
   *
   * Deliberately not persisted: a linking code is valid for ten minutes and is a
   * bearer credential, so the smallest possible blast radius is the right trade —
   * a restart cancels pending links, which is a mild annoyance, whereas a stored
   * code is a durable secret with no compensating benefit.
   */
  private readonly pendingLinks = new Map<string, PendingLink>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cipher: SecretCipher,
  ) {}

  /** Derived, never stored — health is a function of current state. */
  private healthOf(row: {
    enabled: boolean; verifiedAt: Date | null; consecutiveFailures: number;
  }): NotificationChannelHealth {
    if (!row.enabled) return 'disabled';
    if (!row.verifiedAt) return 'unverified';
    if (row.consecutiveFailures >= FAILING_THRESHOLD) return 'failing';
    if (row.consecutiveFailures > 0) return 'degraded';
    return 'healthy';
  }

  private view(row: any): PersonalChannelView {
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      enabled: row.enabled,
      isDefault: row.isDefault,
      destinationMask: row.destinationMask ?? null,
      verified: row.verifiedAt != null,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
      consecutiveFailures: row.consecutiveFailures,
      disabledReason: row.disabledReason ?? null,
      health: this.healthOf(row),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(userId: string): Promise<PersonalChannelView[]> {
    const rows = await this.prisma.userNotificationChannel.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => this.view(r));
  }

  /** Load one connection the acting user owns, or fail as if it did not exist. */
  private async ownedOrThrow(userId: string, id: string) {
    const row = await this.prisma.userNotificationChannel.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!row) {
      this.logger.warn(`User "${userId}" referenced notification connection "${id}" they do not own.`);
      throw new NotFoundException('Connection not found');
    }
    return row;
  }

  async get(userId: string, id: string): Promise<PersonalChannelView> {
    return this.view(await this.ownedOrThrow(userId, id));
  }

  /**
   * Create a connection.
   *
   * Telegram is rejected here on purpose: its chat id must come from the linking
   * flow, because accepting one from the client would let a user point a connection
   * at somebody else's chat and send them their own notifications.
   */
  async create(
    userId: string,
    input: { type: ConnectionBackedChannelType; name?: string; config?: Record<string, unknown> },
  ): Promise<PersonalChannelView> {
    if (input.type === 'telegram') {
      throw new BadRequestException('Telegram connections are created through the linking flow');
    }
    const validation = validatePersonalChannelConfig(input.type, input.config ?? {});
    if (!validation.valid) throw new BadRequestException(validation.reason ?? 'invalid_config');

    const row = await this.persist(userId, input.type, input.name?.trim() || input.type, validation);
    await this.audit.record({
      userId, action: 'notification.channel.created',
      objectType: 'user_notification_channel', objectId: row.id,
      metadata: { type: input.type, destination: validation.destinationMask },
    });
    return this.view(row);
  }

  private async persist(
    userId: string,
    type: ConnectionBackedChannelType,
    name: string,
    validation: { config?: Record<string, unknown> | object; destinationMask?: string },
  ) {
    const field = secretFieldFor(type);
    if (!field) throw new BadRequestException('Unsupported channel type');
    const plain = (validation.config as Record<string, unknown>)[field];
    const encryptedConfig = { [field]: this.cipher.encrypt(String(plain)) };

    // First connection of a type becomes the default, so an event that names the
    // type without naming a connection still has somewhere to go.
    const existing = await this.prisma.userNotificationChannel.count({
      where: { userId, type, deletedAt: null },
    });
    return this.prisma.userNotificationChannel.create({
      data: {
        userId, type, name,
        encryptedConfig: encryptedConfig as object,
        destinationMask: validation.destinationMask ?? null,
        isDefault: existing === 0,
      },
    });
  }

  /** Decrypt a connection's config for delivery. Never exposed over the API. */
  async revealConfig(userId: string, id: string): Promise<Record<string, string>> {
    const row = await this.ownedOrThrow(userId, id);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries((row.encryptedConfig ?? {}) as Record<string, string>)) {
      try {
        out[k] = this.cipher.decrypt(v);
      } catch {
        // A config that cannot be decrypted (rotated key) must not deliver to a
        // garbage destination — surface it as unusable rather than guessing.
        this.logger.error(`Connection "${id}" has undecryptable config; treating as invalid.`);
        throw new BadRequestException('Connection configuration is unreadable');
      }
    }
    return out;
  }

  async rename(userId: string, id: string, name: string): Promise<PersonalChannelView> {
    await this.ownedOrThrow(userId, id);
    const row = await this.prisma.userNotificationChannel.update({
      where: { id }, data: { name: name.trim() || 'Connection' },
    });
    await this.audit.record({
      userId, action: 'notification.channel.updated',
      objectType: 'user_notification_channel', objectId: id,
    });
    return this.view(row);
  }

  async setEnabled(userId: string, id: string, enabled: boolean): Promise<PersonalChannelView> {
    await this.ownedOrThrow(userId, id);
    const row = await this.prisma.userNotificationChannel.update({
      where: { id },
      data: { enabled, disabledReason: enabled ? null : 'disabled_by_user' },
    });
    await this.audit.record({
      userId, action: enabled ? 'notification.channel.enabled' : 'notification.channel.disabled',
      objectType: 'user_notification_channel', objectId: id,
    });
    return this.view(row);
  }

  /** Exactly one default per type. */
  async makeDefault(userId: string, id: string): Promise<PersonalChannelView> {
    const row = await this.ownedOrThrow(userId, id);
    await this.prisma.userNotificationChannel.updateMany({
      where: { userId, type: row.type, deletedAt: null }, data: { isDefault: false },
    });
    const updated = await this.prisma.userNotificationChannel.update({
      where: { id }, data: { isDefault: true },
    });
    return this.view(updated);
  }

  /**
   * Revoke a connection.
   *
   * Soft delete: delivery history references it, and hard-deleting would either
   * cascade that history away or leave it dangling. Routes pointing at it are
   * removed, since a route to a revoked destination would silently never deliver.
   */
  async remove(userId: string, id: string): Promise<{ id: string; routesRemoved: number }> {
    await this.ownedOrThrow(userId, id);
    const { count } = await this.prisma.userNotificationEventRoute.deleteMany({
      where: { channelConnectionId: id },
    });
    await this.prisma.userNotificationChannel.update({
      where: { id },
      data: { deletedAt: new Date(), enabled: false, disabledReason: 'revoked' },
    });
    await this.audit.record({
      userId, action: 'notification.channel.revoked',
      objectType: 'user_notification_channel', objectId: id,
      metadata: { routesRemoved: count },
    });
    return { id, routesRemoved: count };
  }

  /** Record the outcome of a send/test, which is what health is derived from. */
  async recordResult(id: string, ok: boolean, error?: string): Promise<void> {
    await this.prisma.userNotificationChannel.update({
      where: { id },
      data: ok
        ? { lastSuccessAt: new Date(), consecutiveFailures: 0 }
        : { lastFailureAt: new Date(), consecutiveFailures: { increment: 1 }, disabledReason: error ?? null },
    });
  }

  /**
   * Mark a connection verified.
   *
   * Verification is only ever granted by a real round trip (a delivered test, a
   * confirmed link) — never by the user asserting it, which would make the flag
   * meaningless and let delivery target an address nobody proved they control.
   */
  async markVerified(userId: string, id: string): Promise<PersonalChannelView> {
    await this.ownedOrThrow(userId, id);
    const row = await this.prisma.userNotificationChannel.update({
      where: { id },
      data: { verifiedAt: new Date(), lastTestedAt: new Date(), lastSuccessAt: new Date(), consecutiveFailures: 0 },
    });
    await this.audit.record({
      userId, action: 'notification.channel.verified',
      objectType: 'user_notification_channel', objectId: id,
    });
    return this.view(row);
  }

  // --- Telegram linking ----------------------------------------------------

  /**
   * Begin linking: issue a one-time code the user sends to the bot.
   *
   * The code is returned once and stored only as a SHA-256 hash, so the store
   * cannot yield a usable code. It expires in ten minutes and is single-use.
   */
  async startTelegramLink(userId: string, name: string): Promise<{ code: string; expiresInSeconds: number }> {
    const code = randomBytes(4).toString('hex').toUpperCase(); // 8 chars, easy to retype
    const codeHash = createHash('sha256').update(code).digest('hex');
    this.pruneExpiredLinks();
    this.pendingLinks.set(codeHash, {
      userId,
      name: name?.trim() || 'Telegram',
      codeHash,
      expiresAt: Date.now() + LINK_CODE_TTL_MS,
    });
    await this.audit.record({
      userId, action: 'notification.channel.link_started',
      objectType: 'user_notification_channel', metadata: { type: 'telegram' },
    });
    return { code, expiresInSeconds: LINK_CODE_TTL_MS / 1000 };
  }

  /**
   * Complete linking when the bot reports `code` from `chatId`.
   *
   * The code is consumed on first use, so a replayed one cannot bind a second chat.
   * A chat already bound to a DIFFERENT user is refused outright: silently
   * re-pointing it would divert that person's notifications to whoever linked last.
   */
  async confirmTelegramLink(code: string, chatId: string): Promise<PersonalChannelView> {
    this.pruneExpiredLinks();
    const codeHash = createHash('sha256').update((code ?? '').trim().toUpperCase()).digest('hex');
    const pending = this.pendingLinks.get(codeHash);
    if (!pending || pending.expiresAt < Date.now()) throw new BadRequestException('Invalid or expired linking code');
    this.pendingLinks.delete(codeHash); // single use, consumed even if the rest fails

    const existing = await this.prisma.userNotificationChannel.findFirst({
      where: { type: 'telegram', destinationMask: { not: null }, deletedAt: null,
               userId: { not: pending.userId } },
      select: { id: true, userId: true, encryptedConfig: true },
    });
    if (existing) {
      for (const [, v] of Object.entries((existing.encryptedConfig ?? {}) as Record<string, string>)) {
        // Decrypt INSIDE the guard, compare OUTSIDE it. Throwing from inside the
        // try would be swallowed by its own catch, silently disabling this check.
        let decrypted: string | null = null;
        try {
          decrypted = this.cipher.decrypt(v);
        } catch {
          decrypted = null; // undecryptable rows cannot collide meaningfully
        }
        if (decrypted === chatId) {
          this.logger.warn('Telegram chat is already linked to a different user; refusing to re-point it.');
          throw new BadRequestException('This Telegram chat is already linked to another account');
        }
      }
    }

    const validation = validatePersonalChannelConfig('telegram', { chatId });
    if (!validation.valid) throw new BadRequestException(validation.reason ?? 'invalid_config');
    const row = await this.persist(pending.userId, 'telegram', pending.name, validation);
    // A completed round trip through the bot IS the proof of control.
    const verified = await this.prisma.userNotificationChannel.update({
      where: { id: row.id }, data: { verifiedAt: new Date() },
    });
    await this.audit.record({
      userId: pending.userId, action: 'notification.channel.link_confirmed',
      objectType: 'user_notification_channel', objectId: row.id, metadata: { type: 'telegram' },
    });
    return this.view(verified);
  }

  private pruneExpiredLinks(): void {
    const now = Date.now();
    for (const [k, v] of this.pendingLinks) if (v.expiresAt < now) this.pendingLinks.delete(k);
  }
}
