import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretCipher } from '../../common/crypto/secret-cipher';

const TELEGRAM_KEY = 'notifications.telegram';
const API_BASE = 'https://api.telegram.org';
/** Telegram rejects a message over 4096 characters outright. */
const MAX_MESSAGE = 4096;
const TIMEOUT_MS = 10_000;

interface TelegramConfig {
  encryptedToken?: string;
  botUsername?: string;
}

export interface TelegramSettings {
  configured: boolean;
  botUsername: string;
}

/** One inbound message, reduced to what linking needs. */
export interface TelegramUpdate {
  updateId: number;
  chatId: string;
  text: string;
  /** Who sent it, for the duplicate-chat check and for display. */
  fromUsername: string | null;
}

/**
 * The platform's single Telegram bot.
 *
 * **One bot, many chats** — the same shape as email: the bot token is
 * infrastructure an operator configures once, and each user links their own
 * chat to it. No user ever supplies a token, so there is no per-user credential
 * to leak, and no user needs to create a bot.
 *
 * The token is AES-256-GCM encrypted at rest and never returned by any endpoint.
 * `getSettings()` reports only whether a bot exists and its public @username,
 * which the UI needs to tell someone where to send their code.
 */
@Injectable()
export class TelegramTransportService {
  private readonly logger = new Logger(TelegramTransportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipher,
  ) {}

  async getSettings(): Promise<TelegramSettings> {
    const cfg = await this.raw();
    return {
      configured: Boolean(cfg.encryptedToken),
      botUsername: cfg.botUsername ?? '',
    };
  }

  /**
   * Store the bot token, verifying it before saving.
   *
   * `getMe` both proves the token works and yields the bot's @username, so an
   * operator cannot save a typo and discover it only when a user tries to link.
   */
  async updateSettings(token: string): Promise<TelegramSettings> {
    const trimmed = (token ?? '').trim();
    if (!trimmed) throw new BadRequestException('A bot token is required.');

    const me = await this.call<{ username?: string }>(trimmed, 'getMe', {});
    if (!me?.username) throw new BadRequestException('Telegram rejected that bot token.');

    const next: TelegramConfig = {
      encryptedToken: this.cipher.encrypt(trimmed),
      botUsername: me.username,
    };
    await this.prisma.setting.upsert({
      where: { key: TELEGRAM_KEY },
      create: { key: TELEGRAM_KEY, value: next as object },
      update: { value: next as object },
    });
    return this.getSettings();
  }

  async isConfigured(): Promise<boolean> {
    return Boolean((await this.raw()).encryptedToken);
  }

  /**
   * Send a message to one chat.
   *
   * HTML parse mode rather than MarkdownV2: MarkdownV2 requires escaping
   * eighteen characters and rejects the entire message on a single miss, and a
   * media title is arbitrary user-visible text. HTML needs five escapes and
   * fails softer.
   */
  async sendMessage(chatId: string, html: string): Promise<void> {
    const token = await this.token();
    await this.call(token, 'sendMessage', {
      chat_id: chatId,
      text: html.slice(0, MAX_MESSAGE),
      parse_mode: 'HTML',
      // Notifications are not conversations; a link preview would push the
      // actual message off screen on mobile.
      disable_web_page_preview: true,
    });
  }

  /**
   * Recent inbound messages.
   *
   * Polled on demand during linking rather than by a background worker: linking
   * is the only thing that reads inbound messages, it is user-initiated, and a
   * permanent poller would hold a connection open for a feature used once per
   * user. `offset` acknowledges everything before it, so a consumed update
   * cannot be replayed.
   */
  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    const token = await this.token();
    const result = await this.call<Array<Record<string, unknown>>>(token, 'getUpdates', {
      ...(offset !== undefined && { offset }),
      limit: 100,
      timeout: 0,
      allowed_updates: ['message'],
    });
    if (!Array.isArray(result)) return [];

    return result
      .map((update) => {
        const message = update.message as Record<string, unknown> | undefined;
        const chat = message?.chat as Record<string, unknown> | undefined;
        const from = message?.from as Record<string, unknown> | undefined;
        if (!chat?.id || typeof message?.text !== 'string') return null;
        return {
          updateId: Number(update.update_id),
          chatId: String(chat.id),
          text: message.text,
          fromUsername: typeof from?.username === 'string' ? from.username : null,
        };
      })
      .filter((u): u is TelegramUpdate => u !== null);
  }

  private async token(): Promise<string> {
    const cfg = await this.raw();
    if (!cfg.encryptedToken) throw new BadRequestException('Telegram is not configured.');
    return this.cipher.decrypt(cfg.encryptedToken);
  }

  /**
   * One Bot API call.
   *
   * Bounded by a timeout so a hanging Telegram cannot wedge a request thread,
   * and the token is never included in a thrown message — an error string can
   * reach a log, a UI, or a bug report.
   */
  private async call<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean; result?: T; description?: string;
      };
      if (!res.ok || !json.ok) {
        throw new BadRequestException(json.description ?? `Telegram ${method} failed (${res.status}).`);
      }
      return json.result as T;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new BadRequestException('Telegram did not respond in time.');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async raw(): Promise<TelegramConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: TELEGRAM_KEY } });
    return (row?.value as TelegramConfig) ?? {};
  }
}
