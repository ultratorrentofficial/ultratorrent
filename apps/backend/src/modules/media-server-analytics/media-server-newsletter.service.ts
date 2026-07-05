import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MODULE_IDS } from '@ultratorrent/shared';
import type { MediaServerNewsletter } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ModuleRegistryService } from '../module-registry/module-registry.service';
import { MediaServerEmailService } from './media-server-email.service';
import { buildContent, renderHtml, renderText, NewsletterContent, NewsletterItem } from './newsletter-render';

interface NewsletterInput {
  name?: string;
  enabled?: boolean;
  frequency?: string;
  recipientEmails?: string[];
  contentSections?: string[];
  subjectTemplate?: string;
  dateRangeMode?: string;
  lastDays?: number;
}

const VERSION = '0.15.0';

@Injectable()
export class MediaServerNewsletterService {
  private readonly logger = new Logger(MediaServerNewsletterService.name);
  private sending = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: MediaServerEmailService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    private readonly registry: ModuleRegistryService,
  ) {}

  list() {
    return this.prisma.mediaServerNewsletter.findMany({ orderBy: { name: 'asc' } });
  }

  async get(id: string) {
    const row = await this.prisma.mediaServerNewsletter.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Newsletter not found');
    return row;
  }

  async create(input: NewsletterInput, userId?: string) {
    const row = await this.prisma.mediaServerNewsletter.create({
      data: {
        name: input.name ?? 'Newsletter',
        enabled: input.enabled ?? true,
        frequency: input.frequency ?? 'weekly',
        recipientEmails: (input.recipientEmails ?? []) as object,
        contentSections: (input.contentSections ?? ['movies', 'episodes']) as object,
        subjectTemplate: input.subjectTemplate,
        dateRangeMode: input.dateRangeMode ?? 'since_last_send',
        lastDays: input.lastDays ?? 7,
      },
    });
    await this.audit.record({ userId, action: 'media_server_analytics.newsletter.created', objectType: 'media_server_newsletter', objectId: row.id });
    return row;
  }

  async update(id: string, input: NewsletterInput, userId?: string) {
    await this.get(id);
    const data: Record<string, unknown> = {};
    for (const k of ['name', 'enabled', 'frequency', 'subjectTemplate', 'dateRangeMode', 'lastDays'] as const) {
      if (input[k] !== undefined) data[k] = input[k];
    }
    if (input.recipientEmails !== undefined) data.recipientEmails = input.recipientEmails as object;
    if (input.contentSections !== undefined) data.contentSections = input.contentSections as object;
    const row = await this.prisma.mediaServerNewsletter.update({ where: { id }, data });
    await this.audit.record({ userId, action: 'media_server_analytics.newsletter.updated', objectType: 'media_server_newsletter', objectId: id });
    return row;
  }

  async remove(id: string, userId?: string) {
    await this.get(id);
    await this.prisma.mediaServerNewsletter.delete({ where: { id } });
    await this.audit.record({ userId, action: 'media_server_analytics.newsletter.deleted', objectType: 'media_server_newsletter', objectId: id });
    return { ok: true as const };
  }

  deliveries(id: string) {
    return this.prisma.mediaServerNewsletterDelivery.findMany({ where: { newsletterId: id }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  /** Build the "added since" content for a newsletter from the Media Manager library. */
  private async content(n: MediaServerNewsletter): Promise<NewsletterContent> {
    const now = Date.now();
    const since =
      n.dateRangeMode === 'since_last_send' && n.lastSuccessfulSendAt
        ? n.lastSuccessfulSendAt
        : new Date(now - n.lastDays * 24 * 3600 * 1000);
    const items = await this.prisma.mediaItem.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { title: true, mediaType: true, year: true, season: true, episode: true, createdAt: true },
    });
    const mapped: NewsletterItem[] = items.map((i) => ({ title: i.title, mediaType: i.mediaType, year: i.year, season: i.season, episode: i.episode, addedAt: i.createdAt }));
    return buildContent(mapped, since);
  }

  private subject(n: MediaServerNewsletter, content: NewsletterContent): string {
    return (n.subjectTemplate?.trim() || `What's new — ${n.name}`).replace('{{count}}', String(content.totalItems));
  }

  async preview(id: string) {
    const n = await this.get(id);
    const content = await this.content(n);
    const opts = { title: n.name, version: VERSION };
    return { subject: this.subject(n, content), html: renderHtml(content, opts), text: renderText(content, opts), count: content.totalItems, since: content.since };
  }

  async testSend(id: string, recipient: string, userId?: string) {
    if (!recipient) throw new BadRequestException('A recipient email is required.');
    const n = await this.get(id);
    const content = await this.content(n);
    const opts = { title: n.name, version: VERSION };
    await this.email.send({ to: recipient, subject: `[TEST] ${this.subject(n, content)}`, html: renderHtml(content, opts), text: renderText(content, opts) });
    await this.audit.record({ userId, action: 'media_server_analytics.newsletter.test_sent', objectType: 'media_server_newsletter', objectId: id, metadata: { recipient } });
    return { ok: true as const };
  }

  async sendNow(id: string, userId?: string) {
    const n = await this.get(id);
    if (!(await this.email.isConfigured())) throw new BadRequestException('Configure email settings first.');
    const recipients = (n.recipientEmails as string[]) ?? [];
    if (recipients.length === 0) throw new BadRequestException('This newsletter has no recipients.');

    const content = await this.content(n);
    const opts = { title: n.name, version: VERSION };
    const subject = this.subject(n, content);
    const html = renderHtml(content, opts);
    const text = renderText(content, opts);
    this.realtime.broadcast('media_server.newsletter.generated', { id, count: content.totalItems });

    let sent = 0;
    let failed = 0;
    for (const to of recipients) {
      try {
        await this.email.send({ to, subject, html, text });
        await this.prisma.mediaServerNewsletterDelivery.create({ data: { newsletterId: id, recipientEmail: to, status: 'sent', subject, sentAt: new Date() } });
        sent += 1;
      } catch (err) {
        await this.prisma.mediaServerNewsletterDelivery.create({ data: { newsletterId: id, recipientEmail: to, status: 'failed', subject, errorMessage: (err as Error).message } });
        failed += 1;
      }
    }

    await this.prisma.mediaServerNewsletter.update({ where: { id }, data: { lastSuccessfulSendAt: new Date(), nextRunAt: this.nextRun(n.frequency) } });
    this.realtime.broadcast(failed && !sent ? 'media_server.newsletter.failed' : 'media_server.newsletter.sent', { id, sent, failed });
    await this.audit.record({ userId, action: 'media_server_analytics.newsletter.sent', objectType: 'media_server_newsletter', objectId: id, metadata: { sent, failed } });
    return { sent, failed };
  }

  private nextRun(frequency: string): Date | null {
    const d = new Date();
    if (frequency === 'daily') return new Date(d.getTime() + 24 * 3600 * 1000);
    if (frequency === 'weekly') return new Date(d.getTime() + 7 * 24 * 3600 * 1000);
    if (frequency === 'monthly') return new Date(d.getTime() + 30 * 24 * 3600 * 1000);
    return null; // manual
  }

  private get enabled(): boolean {
    return this.registry.getStatus(MODULE_IDS.MEDIA_SERVER_ANALYTICS)?.enabled ?? false;
  }

  /** Send any scheduled newsletters that are due. */
  @Interval('media_server_newsletter_dispatch', 15 * 60_000)
  async scheduledDispatch(): Promise<void> {
    if (!this.enabled || this.sending) return;
    this.sending = true;
    try {
      if (!(await this.email.isConfigured())) return;
      const due = await this.prisma.mediaServerNewsletter.findMany({
        where: { enabled: true, frequency: { not: 'manual' }, nextRunAt: { lte: new Date() } },
      });
      for (const n of due) {
        try {
          await this.sendNow(n.id);
        } catch (err) {
          this.logger.warn(`Scheduled newsletter ${n.id} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      this.sending = false;
    }
  }
}
