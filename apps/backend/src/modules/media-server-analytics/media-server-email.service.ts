import { Injectable } from '@nestjs/common';
import {
  MailTransportService,
  type EmailAttachment,
  type OutgoingEmail,
} from '../../infrastructure/mail/mail-transport.service';

export type { EmailAttachment, OutgoingEmail };

/**
 * The newsletter module's view of platform email.
 *
 * A thin façade over {@link MailTransportService}, which owns the single SMTP
 * transport. This module used to own it outright — back when newsletters were
 * the only sender — and the config still lives under its historical setting key.
 * Personal notifications now send through the same transport, so the logic moved
 * down and this stayed as the surface the newsletter code and its controller
 * already call.
 */
@Injectable()
export class MediaServerEmailService {
  constructor(private readonly mail: MailTransportService) {}

  /** Redacted settings (never returns the password). */
  getSettings() {
    return this.mail.getSettings();
  }

  updateSettings(input: {
    host?: string; port?: number; secure?: boolean; auth?: boolean; user?: string;
    password?: string; fromName?: string; fromAddress?: string;
  }) {
    return this.mail.updateSettings(input);
  }

  isConfigured(): Promise<boolean> {
    return this.mail.isConfigured();
  }

  send(email: OutgoingEmail): Promise<void> {
    return this.mail.send(email);
  }

  async testEmail(to: string): Promise<{ ok: boolean }> {
    await this.mail.send({
      to,
      subject: 'UltraTorrent — SMTP test',
      html: '<p>Your UltraTorrent email settings are working. 🎉</p>',
      text: 'Your UltraTorrent email settings are working.',
    });
    return { ok: true };
  }
}
