import { BadRequestException, Injectable } from '@nestjs/common';
import {
  MailTransportService,
  type EmailAttachment,
  type OutgoingEmail,
} from '../../infrastructure/mail/mail-transport.service';
import { NewsletterEventsService } from './newsletter-events.service';

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
  constructor(
    private readonly mail: MailTransportService,
    private readonly events: NewsletterEventsService,
  ) {}

  /** Redacted settings (never returns the password). */
  getSettings() {
    return this.mail.getSettings();
  }

  updateSettings(input: {
    host?: string; port?: number; secure?: boolean; auth?: boolean; user?: string;
    password?: string; fromName?: string; fromAddress?: string; tlsServername?: string;
  }) {
    return this.mail.updateSettings(input);
  }

  isConfigured(): Promise<boolean> {
    return this.mail.isConfigured();
  }

  send(email: OutgoingEmail): Promise<void> {
    return this.mail.send(email);
  }

  /**
   * Send the "are these settings working?" probe, and record what happened.
   *
   * Recorded with a NULL `newsletterId`, which the events table exists to allow:
   * this checks the platform transport, not any one newsletter. It therefore
   * shows in the activity feed spanning every newsletter — where somebody asking
   * "did anything go out tonight?" is looking — without appearing in the history
   * of a newsletter it says nothing about.
   */
  async testEmail(to: string): Promise<{ ok: boolean }> {
    // Refused here as well as in the UI: the button is the usual caller, not the
    // only possible one, and an empty envelope recipient fails deeper down with
    // a worse message.
    if (!to.trim()) throw new BadRequestException('A recipient email is required.');
    try {
      await this.mail.send({
        to,
        subject: 'UltraTorrent — SMTP test',
        html: '<p>Your UltraTorrent email settings are working. 🎉</p>',
        text: 'Your UltraTorrent email settings are working.',
      });
    } catch (err) {
      const reason = (err as Error).message;
      await this.events.record({
        newsletterId: null, level: 'error', eventType: 'test_sent',
        messageKey: 'newsletter.event.smtpTestFailed',
        messageParams: { recipient: to },
        sanitizedMessage: reason,
        metadata: { recipient: to, error: reason, outcome: 'failed', scope: 'smtp_settings' },
      });
      // The reason, not a bare 500. This is the screen an operator is on while
      // CHANGING the settings, so "Internal server error" is the least useful
      // thing it could say about a configuration they are mid-way through fixing.
      throw new BadRequestException(reason);
    }
    await this.events.record({
      newsletterId: null, level: 'success', eventType: 'test_sent',
      messageKey: 'newsletter.event.smtpTestSent',
      messageParams: { recipient: to },
      metadata: { recipient: to, outcome: 'sent', scope: 'smtp_settings' },
    });
    return { ok: true };
  }
}
