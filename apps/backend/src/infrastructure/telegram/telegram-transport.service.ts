import { BadRequestException, Injectable } from '@nestjs/common';

const API_BASE = 'https://api.telegram.org';
/** Telegram rejects a message over 4096 characters outright. */
const MAX_MESSAGE = 4096;
/** A photo caption is capped far lower than a message. */
const MAX_CAPTION = 1024;
const TIMEOUT_MS = 10_000;
/** Uploading an image legitimately takes longer than a JSON call. */
const UPLOAD_TIMEOUT_MS = 30_000;

/** One inbound message, reduced to what linking needs. */
export interface TelegramUpdate {
  updateId: number;
  chatId: string;
  text: string;
  /** Who sent it, for display on the linked connection. */
  fromUsername: string | null;
}

/**
 * The Telegram Bot API, as a pure transport.
 *
 * **Each user brings their own bot**, exactly as each user brings their own
 * Discord webhook. So this service holds no token and reads no settings — every
 * method takes the caller's token. The credential lives on that user's channel
 * connection, encrypted, and is decrypted only by `NotificationChannelService`.
 *
 * It was originally one shared bot configured by an operator, on the theory that
 * a bot token is infrastructure like the SMTP relay. It is not: an SMTP relay is
 * a server the platform owns, while a bot is a Telegram identity the *person*
 * owns, and requiring an operator step before anyone could use Telegram made a
 * personal channel depend on an administrator.
 */
@Injectable()
export class TelegramTransportService {
  /**
   * Prove a token works and learn the bot's @username.
   *
   * Called before a token is ever stored: an operator — or here, a user — must
   * not be able to save a typo and discover it only when a message fails to
   * arrive. The username is public and is what the UI tells them to message.
   */
  async verifyToken(token: string): Promise<{ username: string }> {
    const trimmed = (token ?? '').trim();
    if (!trimmed) throw new BadRequestException('A bot token is required.');

    const me = await this.call<{ username?: string }>(trimmed, 'getMe', {});
    if (!me?.username) throw new BadRequestException('Telegram rejected that bot token.');
    return { username: me.username };
  }

  /**
   * Send a message to one chat.
   *
   * HTML parse mode rather than MarkdownV2: MarkdownV2 requires escaping
   * eighteen characters and rejects the entire message on a single miss, and a
   * media title is arbitrary user-visible text. HTML needs five escapes and
   * fails softer.
   */
  async sendMessage(
    token: string,
    chatId: string,
    html: string,
    button?: { text: string; url: string } | null,
  ): Promise<void> {
    await this.call(token, 'sendMessage', {
      chat_id: chatId,
      text: html.slice(0, MAX_MESSAGE),
      parse_mode: 'HTML',
      // Notifications are not conversations; a link preview would push the
      // actual message off screen on mobile.
      disable_web_page_preview: true,
      ...(button && { reply_markup: { inline_keyboard: [[button]] } }),
    });
  }

  /**
   * Send a photo with a caption and at most one inline button.
   *
   * The image is uploaded as **multipart bytes**, never a URL. Telegram will
   * happily fetch a link, but that would mean minting a publicly reachable
   * artwork URL that outlives the notification — the exact thing the
   * presentation model refuses to do. Uploading bytes keeps library artwork
   * behind the platform's own auth and leaves nothing fetchable afterwards.
   *
   * Callers must fall back to `sendMessage` if this throws: an image is an
   * enhancement, and a notification that fails to arrive because a poster was
   * unavailable is worse than a plain one.
   */
  async sendPhoto(
    token: string,
    chatId: string,
    photo: { bytes: Buffer; filename: string; contentType: string },
    caption: string,
    button?: { text: string; url: string } | null,
  ): Promise<void> {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption.slice(0, MAX_CAPTION));
    form.append('parse_mode', 'HTML');
    if (button) {
      form.append('reply_markup', JSON.stringify({ inline_keyboard: [[button]] }));
    }
    // Uint8Array view rather than the Buffer itself: undici's Blob rejects a
    // Buffer with a non-zero byteOffset, which a sliced Buffer has.
    const view = new Uint8Array(photo.bytes.buffer, photo.bytes.byteOffset, photo.bytes.byteLength);
    form.append('photo', new Blob([view], { type: photo.contentType }), photo.filename);

    await this.callForm(token, 'sendPhoto', form);
  }

  /**
   * Recent inbound messages for one bot.
   *
   * Polled on demand during linking rather than by a background worker: linking
   * is the only thing that reads inbound messages, it is user-initiated, and a
   * permanent poller would hold a connection open per user for a feature used
   * once. `offset` acknowledges everything before it, so a consumed update
   * cannot be replayed — and it is tracked **per user**, because every user's
   * bot has its own independent update stream.
   */
  async getUpdates(token: string, offset?: number): Promise<TelegramUpdate[]> {
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

  /**
   * One multipart Bot API call.
   *
   * Separate from `call` because fetch must set its own `Content-Type` with the
   * multipart boundary — supplying `application/json` here produces a request
   * Telegram cannot parse, and the failure looks like a bad token.
   *
   * A longer timeout than a JSON call: this uploads an image.
   */
  private async callForm(token: string, method: string, form: FormData): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
      if (!res.ok || !json.ok) {
        throw new BadRequestException(json.description ?? `Telegram ${method} failed (${res.status}).`);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new BadRequestException('Telegram did not respond in time.');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One Bot API call.
   *
   * Bounded by a timeout so a hanging Telegram cannot wedge a request thread,
   * and the token is never included in a thrown message — an error string can
   * reach a log, a UI, or a bug report. It is in the URL, so a fetch failure
   * that echoed the request would leak it; only Telegram's own description is
   * surfaced.
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
}
