import {
  BaseNotificationProvider,
  cardToSms,
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

/** SMS via Twilio. Rich cards collapse to concise plain text automatically. */
export class SmsNotificationProvider extends BaseNotificationProvider {
  readonly kind: NotificationKind = 'sms';

  capabilities(): NotificationCapabilities {
    return {
      richCards: false, images: false, buttons: false, markdown: false, attachments: false,
      scheduling: false, priority: false, readReceipts: false, templates: true, media: false,
      typingIndicators: false, threads: false, reactions: false,
    };
  }

  validateConfiguration(config: NotificationProviderConfig): ConfigValidation {
    const c = config as TwilioConfig;
    const errors: string[] = [];
    if (!c.accountSid) errors.push('accountSid is required');
    if (!c.fromNumber) errors.push('fromNumber is required');
    return { ok: errors.length === 0, errors };
  }

  validateRecipient(addr: NotificationAddress): boolean {
    return !!addr.phone && E164.test(addr.phone.replace(/[\s()-]/g, ''));
  }

  normalizeRecipient(addr: NotificationAddress): string | null {
    if (!addr.phone) return null;
    const clean = addr.phone.replace(/[\s()-]/g, '');
    return E164.test(clean) ? (clean.startsWith('+') ? clean : `+${clean}`) : null;
  }

  async testConnection(config: NotificationProviderConfig): Promise<HealthResult> {
    return twilioHealth(config as TwilioConfig);
  }

  async send(config: NotificationProviderConfig, addr: NotificationAddress, msg: NotificationMessage): Promise<SendResult> {
    const c = config as TwilioConfig;
    const to = this.normalizeRecipient(addr);
    if (!to) return { ok: false, error: 'invalid SMS recipient' };
    if (!c.fromNumber) return { ok: false, error: 'fromNumber not configured' };
    const body = msg.text?.trim() || cardToSms(msg.card);
    return sendTwilioMessage(c, { from: c.fromNumber, to, body });
  }
}
