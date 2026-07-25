import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ConnectableChannelType } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { SecretCipher } from '../../../common/crypto/secret-cipher';
import { isValidEmail, maskEmail } from './channel-validators';
import { maskDiscordWebhook, parseDiscordWebhook } from './discord-validators';

/** What the API returns for a connection. Never the destination itself. */
export interface ChannelView {
  type: ConnectableChannelType;
  connected: boolean;
  enabled: boolean;
  verified: boolean;
  maskedDestination: string | null;
  lastTestedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** healthy | unverified | failing | disabled */
  health: string;
}

/**
 * A user's channel connections.
 *
 * Two invariants:
 *
 * **The decrypted destination never leaves this service.** Endpoints return a
 * mask; only the delivery path calls `resolveDestination`. There is no read
 * method that returns the real address, so no endpoint can accidentally expose
 * one.
 *
 * **An unverified connection is never delivered to.** A typo'd address must fail
 * visibly during setup rather than silently for months, so connecting sends a
 * test and only success sets `verifiedAt`.
 */
@Injectable()
export class NotificationChannelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipher,
  ) {}

  async list(userId: string): Promise<ChannelView[]> {
    const rows = await this.prisma.userNotificationChannel.findMany({
      where: { userId, deletedAt: null },
    });
    const byType = new Map(rows.map((r) => [r.type, r]));
    return (['email', 'telegram', 'discord'] as ConnectableChannelType[]).map((type) => {
      const row = byType.get(type);
      if (!row) {
        return {
          type, connected: false, enabled: false, verified: false,
          maskedDestination: null, lastTestedAt: null, lastSuccessAt: null,
          lastFailureAt: null, lastError: null, consecutiveFailures: 0,
          health: 'disabled',
        };
      }
      return {
        type,
        connected: true,
        enabled: row.enabled,
        verified: row.verifiedAt !== null,
        maskedDestination: row.maskedDestination,
        lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
        lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
        lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
        lastError: row.lastError,
        consecutiveFailures: row.consecutiveFailures,
        health: this.health(row),
      };
    });
  }

  private health(row: {
    enabled: boolean; verifiedAt: Date | null; consecutiveFailures: number;
  }): string {
    if (!row.enabled) return 'disabled';
    if (!row.verifiedAt) return 'unverified';
    if (row.consecutiveFailures >= 3) return 'failing';
    return 'healthy';
  }

  /**
   * Connect (or re-point) this user's email destination.
   *
   * Stored unverified. The caller sends a test immediately and calls
   * `markVerified` on success — connecting and proving deliverability are two
   * steps on purpose, because an address that cannot receive is worse than no
   * address at all: the user believes they are covered.
   */
  async connectEmail(userId: string, address: string): Promise<ChannelView> {
    const trimmed = (address ?? '').trim();
    if (!isValidEmail(trimmed)) throw new BadRequestException('That is not a valid email address.');

    await this.prisma.userNotificationChannel.upsert({
      where: { userId_type: { userId, type: 'email' } },
      create: {
        userId,
        type: 'email',
        encryptedConfig: { address: this.cipher.encrypt(trimmed) },
        maskedDestination: maskEmail(trimmed),
        enabled: true,
      },
      update: {
        encryptedConfig: { address: this.cipher.encrypt(trimmed) },
        maskedDestination: maskEmail(trimmed),
        enabled: true,
        // Re-pointing resets proof: the new address has not demonstrated it can
        // receive anything, and carrying the old verification over would let a
        // typo inherit a working address's trust.
        verifiedAt: null,
        consecutiveFailures: 0,
        lastError: null,
        deletedAt: null,
      },
    });
    return this.viewOf(userId, 'email');
  }

  /**
   * Link a Telegram chat to this user, after they proved control of it.
   *
   * Verified immediately: unlike email, redeeming a code IS the proof — the
   * message could only have come from a chat the user controls, so asking them
   * to also pass a test would be ceremony.
   *
   * Refuses a chat already linked to a different account. Without that check,
   * two users could point at one chat and each would silently receive the
   * other's notifications.
   */
  async connectTelegram(
    userId: string,
    chatId: string,
    username: string | null,
  ): Promise<ChannelView> {
    const claimed = await this.prisma.userNotificationChannel.findMany({
      where: { type: 'telegram', deletedAt: null },
      select: { userId: true, encryptedConfig: true },
    });
    for (const row of claimed) {
      if (row.userId === userId) continue;
      const config = (row.encryptedConfig ?? {}) as Record<string, unknown>;
      if (typeof config.chatId !== 'string') continue;
      let existing: string;
      try {
        existing = this.cipher.decrypt(config.chatId);
      } catch {
        continue; // unreadable after a key rotation — cannot conflict
      }
      if (existing === chatId) {
        throw new BadRequestException('That Telegram chat is already linked to another account.');
      }
    }

    await this.prisma.userNotificationChannel.upsert({
      where: { userId_type: { userId, type: 'telegram' } },
      create: {
        userId,
        type: 'telegram',
        encryptedConfig: { chatId: this.cipher.encrypt(chatId) },
        maskedDestination: username ? `@${username}` : 'Telegram chat',
        enabled: true,
        verifiedAt: new Date(),
      },
      update: {
        encryptedConfig: { chatId: this.cipher.encrypt(chatId) },
        maskedDestination: username ? `@${username}` : 'Telegram chat',
        enabled: true,
        verifiedAt: new Date(),
        consecutiveFailures: 0,
        lastError: null,
        deletedAt: null,
      },
    });
    return this.viewOf(userId, 'telegram');
  }

  /**
   * Connect a personal Discord webhook.
   *
   * Stored **unverified** — the caller sends a test and calls `markVerified` on
   * success, exactly as with email. A webhook that Discord has since revoked
   * parses fine and fails at send, so parsing is not proof of anything.
   *
   * The full URL never leaves this service: it is encrypted, and the mask shows
   * a channel name plus the last four digits of the webhook id. The token half
   * of the URL is a bearer credential and is never displayed, not even partially.
   */
  async connectDiscord(
    userId: string,
    webhookUrl: string,
    channelName: string | null,
  ): Promise<ChannelView> {
    // Validated here as well as in the transport: a row must never be written
    // with a URL that would be refused at send time.
    const { url, webhookId } = parseDiscordWebhook(webhookUrl);

    await this.prisma.userNotificationChannel.upsert({
      where: { userId_type: { userId, type: 'discord' } },
      create: {
        userId,
        type: 'discord',
        encryptedConfig: { webhookUrl: this.cipher.encrypt(url) },
        maskedDestination: maskDiscordWebhook(webhookId, channelName),
        enabled: true,
      },
      update: {
        encryptedConfig: { webhookUrl: this.cipher.encrypt(url) },
        maskedDestination: maskDiscordWebhook(webhookId, channelName),
        enabled: true,
        // A new webhook has proved nothing; carrying verification over would let
        // a revoked one inherit a working one's trust.
        verifiedAt: null,
        consecutiveFailures: 0,
        lastError: null,
        deletedAt: null,
      },
    });
    return this.viewOf(userId, 'discord');
  }

  /**
   * The real destination, for the delivery path only.
   *
   * Returns null unless the connection exists, is enabled and is verified —
   * every precondition re-checked at send time rather than trusted from when the
   * delivery was queued, because a user can disconnect in between.
   */
  async resolveDestination(
    userId: string,
    type: ConnectableChannelType,
  ): Promise<{ id: string; address: string } | null> {
    const row = await this.prisma.userNotificationChannel.findFirst({
      where: { userId, type, deletedAt: null, enabled: true, verifiedAt: { not: null } },
    });
    if (!row) return null;
    return this.decodeDestination(row);
  }

  /** Destination for a test, which by definition runs before verification. */
  async resolveForTest(
    userId: string,
    type: ConnectableChannelType,
  ): Promise<{ id: string; address: string } | null> {
    const row = await this.prisma.userNotificationChannel.findFirst({
      where: { userId, type, deletedAt: null },
    });
    if (!row) return null;
    return this.decodeDestination(row);
  }

  /**
   * Decrypt whichever destination field this channel type stores.
   *
   * One place, so a new channel adds a field name rather than another
   * copy of the decrypt-and-swallow dance.
   */
  private decodeDestination(row: { id: string; encryptedConfig: unknown }):
    { id: string; address: string } | null {
    const config = (row.encryptedConfig ?? {}) as Record<string, unknown>;
    const encrypted = [config.address, config.chatId, config.webhookUrl]
      .find((v): v is string => typeof v === 'string');
    if (!encrypted) return null;
    try {
      return { id: row.id, address: this.cipher.decrypt(encrypted) };
    } catch {
      // A rotated key makes the destination unreadable. Terminal, not retried —
      // every attempt would fail identically.
      return null;
    }
  }

  async markVerified(userId: string, type: ConnectableChannelType): Promise<ChannelView> {
    await this.prisma.userNotificationChannel.updateMany({
      where: { userId, type, deletedAt: null },
      data: { verifiedAt: new Date(), lastTestedAt: new Date(), lastSuccessAt: new Date(),
              consecutiveFailures: 0, lastError: null },
    });
    return this.viewOf(userId, type);
  }

  async recordFailure(userId: string, type: ConnectableChannelType, error: string): Promise<void> {
    await this.prisma.userNotificationChannel.updateMany({
      where: { userId, type, deletedAt: null },
      data: {
        lastFailureAt: new Date(),
        lastTestedAt: new Date(),
        lastError: error.slice(0, 500),
        consecutiveFailures: { increment: 1 },
      },
    });
  }

  async recordSuccess(userId: string, type: ConnectableChannelType): Promise<void> {
    await this.prisma.userNotificationChannel.updateMany({
      where: { userId, type, deletedAt: null },
      data: { lastSuccessAt: new Date(), consecutiveFailures: 0, lastError: null },
    });
  }

  /**
   * Disconnect.
   *
   * A soft delete, so the unique (userId, type) slot frees up on reconnect while
   * the row's failure history survives for support questions.
   */
  async disconnect(userId: string, type: ConnectableChannelType): Promise<void> {
    const result = await this.prisma.userNotificationChannel.updateMany({
      where: { userId, type, deletedAt: null },
      data: { deletedAt: new Date(), enabled: false, verifiedAt: null },
    });
    if (result.count === 0) throw new NotFoundException('No such connection.');
  }

  private async viewOf(userId: string, type: ConnectableChannelType): Promise<ChannelView> {
    const all = await this.list(userId);
    return all.find((c) => c.type === type)!;
  }
}
