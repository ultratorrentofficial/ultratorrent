import {
  BaseNotificationProvider,
  cardToText,
  type ConfigValidation,
  type HealthResult,
  type NotificationAddress,
  type NotificationCapabilities,
  type NotificationKind,
  type NotificationMessage,
  type NotificationProviderConfig,
  type SendResult,
} from '../notification-provider';
import { E164, sendTwilioMessage, twilioHealth, type TwilioConfig } from './twilio';

/** WhatsApp via Twilio (same account as SMS). Sends rich text + poster media. */
export class WhatsAppNotificationProvider extends BaseNotificationProvider {
  readonly kind: NotificationKind = 'whatsapp';

  capabilities(): NotificationCapabilities {
    return {
      richCards: true, images: true, buttons: false, markdown: true, attachments: true,
      scheduling: false, priority: false, readReceipts: true, templates: true, media: true,
      typingIndicators: false, threads: false, reactions: true,
    };
  }

  validateConfiguration(config: NotificationProviderConfig): ConfigValidation {
    const c = config as TwilioConfig;
    const errors: string[] = [];
    if (!c.accountSid) errors.push('accountSid is required');
    if (!c.fromNumber) errors.push('fromNumber (WhatsApp-enabled) is required');
    return { ok: errors.length === 0, errors };
  }

  private clean(n?: string | null): string | null {
    if (!n) return null;
    const c = n.replace(/^whatsapp:/, '').replace(/[\s()-]/g, '');
    return E164.test(c) ? (c.startsWith('+') ? c : `+${c}`) : null;
  }

  validateRecipient(addr: NotificationAddress): boolean {
    return this.clean(addr.whatsappNumber ?? addr.phone) != null;
  }

  normalizeRecipient(addr: NotificationAddress): string | null {
    return this.clean(addr.whatsappNumber ?? addr.phone);
  }

  async testConnection(config: NotificationProviderConfig): Promise<HealthResult> {
    return twilioHealth(config as TwilioConfig);
  }

  async send(config: NotificationProviderConfig, addr: NotificationAddress, msg: NotificationMessage): Promise<SendResult> {
    const c = config as TwilioConfig;
    const to = this.normalizeRecipient(addr);
    if (!to) return { ok: false, error: 'invalid WhatsApp recipient' };
    const from = this.clean(c.fromNumber);
    if (!from) return { ok: false, error: 'fromNumber not configured' };
    const body = msg.markdown ?? msg.text?.trim() ?? cardToText(msg.card);
    return sendTwilioMessage(c, {
      from: `whatsapp:${from}`,
      to: `whatsapp:${to}`,
      body,
      mediaUrl: msg.card.posterUrl ?? undefined,
    });
  }
}
