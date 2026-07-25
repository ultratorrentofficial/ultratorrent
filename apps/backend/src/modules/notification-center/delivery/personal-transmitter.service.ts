import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { SecretCipher } from '../../../common/crypto/secret-cipher';
import { getNotificationProvider } from '../provider-registry';
import { classifyHttpStatus, classifyThrown, parseRetryAfter, type DeliveryErrorClass } from './delivery-policy';

/** Outcome of one transmission attempt. */
export interface TransmitResult {
  ok: boolean;
  /** True only when the provider ACCEPTED the request — not proof of receipt. */
  accepted?: boolean;
  errorClass?: DeliveryErrorClass;
  error?: string;
  retryAfterSeconds?: number | null;
}

/** How long any single provider call may take before it is a timeout. */
const SEND_TIMEOUT_MS = 15_000;

/**
 * Sends one rendered notification to one personal destination.
 *
 * This is the only place that touches a decrypted destination, and it never returns
 * one: a failure is reported as a classified error, so nothing upstream can log a
 * credential by accident.
 *
 * The distinction it preserves everywhere is **accepted ≠ delivered**. Telegram,
 * Discord and an SMTP relay all acknowledge that they took the message, not that a
 * person received it. Recording that as `provider_accepted` rather than `delivered`
 * keeps the history honest.
 */
@Injectable()
export class PersonalTransmitter {
  private readonly logger = new Logger(PersonalTransmitter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipher,
  ) {}

  /** Decrypt a connection's stored destination. */
  private decrypt(encryptedConfig: unknown): Record<string, string> | null {
    try {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries((encryptedConfig ?? {}) as Record<string, string>)) {
        out[k] = this.cipher.decrypt(v);
      }
      return out;
    } catch {
      return null;
    }
  }

  /** A fetch bounded by a timeout, so a hung provider cannot pin a worker slot. */
  private async post(url: string, body: unknown): Promise<TransmitResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.ok) return { ok: true, accepted: true };
      const cls = classifyHttpStatus(res.status);
      return {
        ok: false,
        errorClass: cls,
        // Status only — a provider body can echo the request, which for a webhook
        // means echoing the credential into our logs.
        error: `HTTP ${res.status}`,
        retryAfterSeconds: parseRetryAfter(res.headers.get('retry-after')),
      };
    } catch (err) {
      return { ok: false, errorClass: classifyThrown(err), error: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Send to one connection.
   *
   * `text` is already rendered and localized by the caller; this layer only knows
   * how to hand it to a provider.
   */
  async transmit(
    channelType: string,
    encryptedConfig: unknown,
    subject: string,
    text: string,
  ): Promise<TransmitResult> {
    const config = this.decrypt(encryptedConfig);
    if (!config) {
      // A rotated key makes the destination unreadable. Terminal, and explicitly
      // NOT retried — every attempt would fail identically.
      return { ok: false, errorClass: 'invalid_credentials', error: 'connection configuration unreadable' };
    }

    switch (channelType) {
      case 'discord':
        return this.post(config.webhookUrl, { content: `**${subject}**\n${text}`.slice(0, 1900) });

      case 'telegram': {
        const token = await this.telegramBotToken();
        if (!token) return { ok: false, errorClass: 'invalid_credentials', error: 'no telegram bot configured' };
        return this.post(`https://api.telegram.org/bot${token}/sendMessage`, {
          chat_id: config.chatId,
          text: `${subject}\n\n${text}`.slice(0, 4000),
        });
      }

      case 'whatsapp':
        // The provider seam exists but no personal WhatsApp transport is configured
        // on this install. Reported honestly rather than pretending to send.
        return { ok: false, errorClass: 'unsupported_template', error: 'whatsapp transport not configured' };

      case 'email':
        return this.sendEmail(config.address, subject, text);

      default:
        return { ok: false, errorClass: 'malformed_payload', error: `unsupported channel ${channelType}` };
    }
  }

  /**
   * Email uses the SHARED platform transport with a PERSONAL destination.
   *
   * That is the documented model: the SMTP relay is infrastructure the administrator
   * configures once, while the address it delivers to is the user's own. No user
   * supplies SMTP credentials, so there is no per-user secret to leak.
   */
  private async sendEmail(address: string, subject: string, text: string): Promise<TransmitResult> {
    const transport = await this.prisma.notificationChannel.findFirst({
      where: { provider: 'email', enabled: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!transport) {
      return { ok: false, errorClass: 'unsupported_template', error: 'no email transport configured' };
    }
    try {
      const cfg = this.decrypt((transport.config as Record<string, unknown>)?.['__encrypted'] ? transport.config : null)
        ?? (transport.config as Record<string, string>);
      const provider = getNotificationProvider('email');
      const result = await provider.send(
        cfg as never,
        { email: address } as never,
        { subject, text, html: null, markdown: null, card: { title: subject, subtitle: null } } as never,
      );
      return result?.ok
        ? { ok: true, accepted: true }
        : { ok: false, errorClass: 'provider_unavailable', error: result?.error ?? 'send failed' };
    } catch (err) {
      return { ok: false, errorClass: classifyThrown(err), error: (err as Error).message };
    }
  }

  /** The shared bot token — infrastructure, never a per-user secret. */
  private async telegramBotToken(): Promise<string | null> {
    const row = await this.prisma.notificationChannel.findFirst({
      where: { provider: 'telegram', enabled: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!row) return null;
    const cfg = row.config as Record<string, string>;
    try {
      return cfg.botToken ? this.cipher.decrypt(cfg.botToken) : null;
    } catch {
      return null;
    }
  }
}
