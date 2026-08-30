import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { NewsletterEventsService } from './newsletter-events.service';

/** Stands in for the real token while one email is rendered for everyone. */
export const UNSUB_PLACEHOLDER = '__UT_UNSUB_TOKEN__';

export type UnsubscribeOutcome =
  | { ok: true; newsletterName: string; email: string; alreadyGone: boolean }
  | { ok: false; reason: 'invalid' | 'unknown' };

/**
 * Letting a recipient remove themselves from a newsletter.
 *
 * The footer used to say "Unsubscribe" with no URL behind it. This is the URL.
 *
 * # Why the token is stateless
 *
 * Signed rather than stored: an unsubscribe link has to keep working in an email
 * somebody opens a year from now, and a table of tokens is a table that gets
 * pruned, migrated, or missed by a restore. The signature covers the newsletter
 * AND the address, so a token can only ever remove the person it was issued to —
 * a recipient cannot edit someone else out of the list, and the URL space cannot
 * be walked to unsubscribe everybody.
 *
 * # Why there is no expiry
 *
 * Deliberately unlike the image tokens, which expire in 45 days. An old
 * newsletter is exactly where somebody looks when they want out, and a link that
 * says "expired" to a person trying to leave is worse than useless — it is the
 * behaviour that gets a sender marked as spam.
 */
@Injectable()
export class NewsletterUnsubscribeService {
  private readonly logger = new Logger(NewsletterUnsubscribeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly events: NewsletterEventsService,
  ) {}

  private secret(): string {
    return this.config.get<string>('jwt.accessSecret') ?? '';
  }

  private sign(newsletterId: string, email: string): string {
    return createHmac('sha256', this.secret())
      .update(`${newsletterId}.${email.toLowerCase()}`)
      .digest('base64url');
  }

  /** A token that identifies one recipient of one newsletter. */
  token(newsletterId: string, email: string): string {
    const payload = Buffer.from(`${newsletterId}:${email.toLowerCase()}`).toString('base64url');
    return `${payload}.${this.sign(newsletterId, email)}`;
  }

  /** The address a footer link points at, for one recipient. */
  url(base: string, newsletterId: string, email: string): string {
    const clean = base.replace(/\/+$/, '');
    return `${clean}/api/media-server-analytics/nl-unsubscribe?t=${this.token(newsletterId, email)}`;
  }

  /** Read a token back, or nothing if it was not issued by this instance. */
  parse(token: string | undefined): { newsletterId: string; email: string } | null {
    if (!token) return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    let decoded: string;
    try {
      decoded = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
    } catch {
      return null;
    }
    const sep = decoded.indexOf(':');
    if (sep <= 0) return null;
    const newsletterId = decoded.slice(0, sep);
    const email = decoded.slice(sep + 1);
    if (!newsletterId || !email) return null;

    // Constant-time, so a wrong signature cannot be found a character at a time.
    const expected = Buffer.from(this.sign(newsletterId, email));
    const given = Buffer.from(token.slice(dot + 1));
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return { newsletterId, email };
  }

  /** What the confirmation page needs, without changing anything. */
  async describe(token: string | undefined): Promise<UnsubscribeOutcome> {
    const parsed = this.parse(token);
    if (!parsed) return { ok: false, reason: 'invalid' };
    const n = await this.prisma.mediaServerNewsletter.findUnique({
      where: { id: parsed.newsletterId },
      select: { name: true, brandTitle: true, recipientEmails: true },
    });
    if (!n) return { ok: false, reason: 'unknown' };
    const list = ((n.recipientEmails as string[]) ?? []).map((e) => e.toLowerCase());
    return {
      ok: true,
      newsletterName: n.brandTitle || n.name,
      email: parsed.email,
      alreadyGone: !list.includes(parsed.email.toLowerCase()),
    };
  }

  /**
   * Remove the address, and say so in the newsletter's own activity.
   *
   * Idempotent: unsubscribing twice is a success, not an error. A person who
   * clicks the link in two different newsletters should be told they are off the
   * list both times, not shown a failure the second time.
   */
  async unsubscribe(token: string | undefined): Promise<UnsubscribeOutcome> {
    const parsed = this.parse(token);
    if (!parsed) return { ok: false, reason: 'invalid' };

    const n = await this.prisma.mediaServerNewsletter.findUnique({
      where: { id: parsed.newsletterId },
      select: { id: true, name: true, brandTitle: true, recipientEmails: true },
    });
    if (!n) return { ok: false, reason: 'unknown' };

    const before = (n.recipientEmails as string[]) ?? [];
    const after = before.filter((e) => e.toLowerCase() !== parsed.email.toLowerCase());
    const alreadyGone = after.length === before.length;

    if (!alreadyGone) {
      await this.prisma.mediaServerNewsletter.update({
        where: { id: n.id },
        data: { recipientEmails: after as object },
      });
      await this.events.record({
        newsletterId: n.id,
        level: 'info',
        eventType: 'unsubscribed',
        messageKey: 'newsletter.event.unsubscribed',
        messageParams: { recipient: parsed.email },
        metadata: { recipient: parsed.email, remaining: after.length },
      });
      this.logger.log(`${parsed.email} unsubscribed from newsletter ${n.id}`);
    }

    return {
      ok: true,
      newsletterName: n.brandTitle || n.name,
      email: parsed.email,
      alreadyGone,
    };
  }
}
