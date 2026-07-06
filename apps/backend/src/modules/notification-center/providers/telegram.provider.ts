import {
  BaseNotificationProvider,
  cardToMarkdown,
  type ConfigValidation,
  type HealthResult,
  type NotificationAddress,
  type NotificationCapabilities,
  type NotificationKind,
  type NotificationMessage,
  type NotificationProviderConfig,
  type SendResult,
} from '../notification-provider';

interface TelegramConfig {
  botToken?: string; // decrypted at call time
}

const API = 'https://api.telegram.org';

/** Delivers via the Telegram Bot API: photo + markdown caption + inline buttons. */
export class TelegramNotificationProvider extends BaseNotificationProvider {
  readonly kind: NotificationKind = 'telegram';

  capabilities(): NotificationCapabilities {
    return {
      richCards: true, images: true, buttons: true, markdown: true, attachments: false,
      scheduling: false, priority: false, readReceipts: false, templates: true, media: true,
      typingIndicators: true, threads: true, reactions: true,
    };
  }

  validateConfiguration(config: NotificationProviderConfig): ConfigValidation {
    const c = config as TelegramConfig;
    return c.botToken ? { ok: true, errors: [] } : { ok: false, errors: ['botToken is required'] };
  }

  validateRecipient(addr: NotificationAddress): boolean {
    return !!addr.telegramChatId && /^-?\d+$/.test(addr.telegramChatId.trim());
  }

  normalizeRecipient(addr: NotificationAddress): string | null {
    return addr.telegramChatId ? addr.telegramChatId.trim() : null;
  }

  async testConnection(config: NotificationProviderConfig): Promise<HealthResult> {
    const c = config as TelegramConfig;
    if (!c.botToken) return { ok: false, status: 'offline', error: 'botToken not configured' };
    try {
      const res = await fetch(`${API}/bot${c.botToken}/getMe`, { signal: AbortSignal.timeout(8000) });
      const json = (await res.json()) as { ok?: boolean; description?: string };
      return json.ok ? { ok: true, status: 'online' } : { ok: false, status: 'offline', error: json.description };
    } catch (e) {
      return { ok: false, status: 'offline', error: e instanceof Error ? e.message : String(e) };
    }
  }

  async send(config: NotificationProviderConfig, addr: NotificationAddress, msg: NotificationMessage): Promise<SendResult> {
    const c = config as TelegramConfig;
    const chatId = this.normalizeRecipient(addr);
    if (!c.botToken) return { ok: false, error: 'botToken not configured' };
    if (!chatId) return { ok: false, error: 'invalid telegram chat id' };

    const caption = msg.markdown ?? cardToMarkdown(msg.card);
    const keyboard = (msg.card.buttons ?? []).length
      ? { inline_keyboard: [msg.card.buttons!.map((b) => ({ text: b.label, url: b.url }))] }
      : undefined;
    const usePhoto = Boolean(msg.card.posterUrl);
    const method = usePhoto ? 'sendPhoto' : 'sendMessage';
    const body: Record<string, unknown> = usePhoto
      ? { chat_id: chatId, photo: msg.card.posterUrl, caption, parse_mode: 'Markdown' }
      : { chat_id: chatId, text: caption, parse_mode: 'Markdown', disable_web_page_preview: false };
    if (keyboard) body.reply_markup = keyboard;

    try {
      const res = await fetch(`${API}/bot${c.botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      });
      const json = (await res.json()) as { ok?: boolean; description?: string; result?: { message_id?: number } };
      return json.ok
        ? { ok: true, providerMessageId: json.result?.message_id != null ? String(json.result.message_id) : undefined }
        : { ok: false, error: json.description ?? `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
