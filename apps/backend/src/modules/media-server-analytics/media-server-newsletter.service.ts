import { readFile } from 'node:fs/promises';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { paginate, parsePage } from '../../common/pagination';
import { Interval } from '@nestjs/schedule';
import { MODULE_IDS } from '@ultratorrent/shared';
import type { MediaServerNewsletter } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ModuleRegistryService } from '../module-registry/module-registry.service';
import { MediaServerEmailService, type EmailAttachment } from './media-server-email.service';
import { buildContent, renderHtml, renderText, sampleContent, type NewsletterContent, type NewsletterItem, type RenderOptions } from './newsletter-render';
import { newsletterStrings } from './newsletter-strings';

const ACCENT = '#f5a623';

interface NewsletterInput {
  name?: string;
  enabled?: boolean;
  frequency?: string;
  recipientEmails?: string[];
  contentSections?: string[];
  subjectTemplate?: string;
  dateRangeMode?: string;
  lastDays?: number;
  startDate?: string | null;
}

const VERSION = '0.15.0';
const MAX_ITEMS = 60; // items rendered in the email
const MAX_POSTERS = 30; // posters attached (keeps the email a sane size)
const MAX_POSTER_BYTES = 500 * 1024;

/** A built newsletter ready to send: content + inline poster attachments + render opts. */
interface RenderedNewsletter {
  content: NewsletterContent;
  attachments: EmailAttachment[];
  opts: RenderOptions;
}

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
        startDate: input.startDate ? new Date(input.startDate) : null,
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
    if (input.startDate !== undefined) data.startDate = input.startDate ? new Date(input.startDate) : null;
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

  deliveries(id: string, page?: string, pageSize?: string) {
    return paginate(
      this.prisma.mediaServerNewsletterDelivery,
      { where: { newsletterId: id }, orderBy: { createdAt: 'desc' } },
      parsePage(page, pageSize),
    );
  }

  /** Resolve the "included since" date for a newsletter's configured range mode. */
  private since(n: MediaServerNewsletter): Date {
    const now = Date.now();
    if (n.dateRangeMode === 'since_date' && n.startDate) return n.startDate;
    if (n.dateRangeMode === 'since_last_send' && n.lastSuccessfulSendAt) return n.lastSuccessfulSendAt;
    return new Date(now - n.lastDays * 24 * 3600 * 1000);
  }

  private dateRange(since: Date, until: Date): string {
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    return `${fmt(since)} - ${fmt(until)}`;
  }

  /** The default/first connected media server's name (shown in the header). */
  private async serverName(): Promise<string | undefined> {
    const conn = await this.prisma.mediaServerIntegration.findFirst({
      where: { isEnabled: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: { name: true },
    });
    return conn?.name ?? undefined;
  }

  /** Assemble the render options (localized strings, server, date range, style). */
  private async renderOpts(since: Date, until: Date): Promise<RenderOptions> {
    return {
      strings: newsletterStrings('en-US'),
      version: VERSION,
      serverName: await this.serverName(),
      dateRange: this.dateRange(since, until),
      brand: 'UltraTorrent',
      style: { accent: ACCENT },
    };
  }

  /**
   * Build the "added since" content from the Media Manager library — episodes
   * grouped into shows, movies kept flat — enriched with metadata and inline
   * poster artwork (CID images, so they render without public URLs).
   */
  private async build(n: MediaServerNewsletter): Promise<RenderedNewsletter> {
    const since = this.since(n);
    const until = new Date();
    const rows = await this.prisma.mediaItem.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: MAX_ITEMS,
      select: {
        id: true, title: true, mediaType: true, year: true, season: true, episode: true, createdAt: true,
        library: { select: { name: true } },
        metadata: { select: { overview: true, rating: true, runtime: true, certification: true, genres: true } },
        artwork: { where: { type: 'poster' }, orderBy: { selected: 'desc' }, take: 1, select: { url: true, localPath: true } },
      },
    });

    const posters = new Map<string, { url: string | null; localPath: string | null }>();
    const items: NewsletterItem[] = rows.map((r) => {
      if (r.artwork[0]) posters.set(r.id, r.artwork[0]);
      const g = r.metadata?.genres;
      return {
        id: r.id,
        title: r.title,
        mediaType: r.mediaType,
        year: r.year,
        season: r.season,
        episode: r.episode,
        addedAt: r.createdAt,
        overview: r.metadata?.overview ?? null,
        rating: r.metadata?.rating ?? null,
        runtime: r.metadata?.runtime ?? null,
        certification: r.metadata?.certification ?? null,
        genres: Array.isArray(g) ? (g as string[]) : [],
        library: r.library?.name ?? null,
      };
    });

    const content = buildContent(items, since, until);
    const attachments = await this.assemblePosters(content, posters);
    return { content, attachments, opts: await this.renderOpts(since, until) };
  }

  /**
   * Fetch poster bytes (remote URL or local file) for the first MAX_POSTERS items
   * in render order, attach them as CID images, and stamp `posterCid` on the item.
   * Best-effort: a poster that fails to load simply falls back to a placeholder.
   */
  private async assemblePosters(
    content: NewsletterContent,
    posters: Map<string, { url: string | null; localPath: string | null }>,
  ): Promise<EmailAttachment[]> {
    // One poster per show + per movie, in render order, capped for email size.
    const targets: { id?: string; set: (cid: string) => void }[] = [
      ...content.shows.map((s) => ({ id: s.posterItemId, set: (cid: string) => (s.posterCid = cid) })),
      ...content.movies.map((m) => ({ id: m.id, set: (cid: string) => (m.posterCid = cid) })),
    ];
    const attachments: EmailAttachment[] = [];
    for (const tgt of targets) {
      if (attachments.length >= MAX_POSTERS) break;
      const art = tgt.id ? posters.get(tgt.id) : undefined;
      if (!art) continue;
      const loaded = await this.loadPoster(art);
      if (!loaded) continue;
      const cid = `poster-${tgt.id}`;
      const ext = loaded.contentType.includes('png') ? 'png' : 'jpg';
      attachments.push({ cid, filename: `${cid}.${ext}`, content: loaded.buf, contentType: loaded.contentType });
      tgt.set(cid);
    }
    return attachments;
  }

  private async loadPoster(art: { url: string | null; localPath: string | null }): Promise<{ buf: Buffer; contentType: string } | null> {
    try {
      if (art.url) {
        const res = await fetch(art.url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return null;
        const contentType = res.headers.get('content-type') ?? 'image/jpeg';
        if (!contentType.startsWith('image/')) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        return buf.length > MAX_POSTER_BYTES ? null : { buf, contentType };
      }
      if (art.localPath) {
        const buf = await readFile(art.localPath);
        if (buf.length > MAX_POSTER_BYTES) return null;
        return { buf, contentType: art.localPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg' };
      }
    } catch {
      return null; // artwork is best-effort — never block a send
    }
    return null;
  }

  private subject(n: MediaServerNewsletter, content: NewsletterContent): string {
    return (n.subjectTemplate?.trim() || `What's new — ${n.name}`).replace('{{count}}', String(content.totalItems));
  }

  async preview(id: string) {
    const n = await this.get(id);
    const built = await this.build(n);
    // When nothing was added yet, show a representative sample so the operator
    // still sees the full styled template (never sent — preview only).
    const isSample = built.content.totalItems === 0;
    const content = isSample ? sampleContent() : built.content;
    const attachments = isSample ? [] : built.attachments;
    // The in-app preview iframe can't resolve `cid:` refs, so inline the poster
    // bytes as data URIs — a faithful, self-contained preview of the sent email.
    let html = renderHtml(content, built.opts);
    for (const a of attachments) {
      html = html.split(`cid:${a.cid}`).join(`data:${a.contentType ?? 'image/jpeg'};base64,${a.content.toString('base64')}`);
    }
    return { subject: this.subject(n, built.content), html, text: renderText(content, built.opts), count: built.content.totalItems, since: built.content.since, sample: isSample };
  }

  async testSend(id: string, recipient: string, userId?: string) {
    if (!recipient) throw new BadRequestException('A recipient email is required.');
    const n = await this.get(id);
    const { content, attachments, opts } = await this.build(n);
    await this.email.send({ to: recipient, subject: `[TEST] ${this.subject(n, content)}`, html: renderHtml(content, opts), text: renderText(content, opts), attachments });
    await this.audit.record({ userId, action: 'media_server_analytics.newsletter.test_sent', objectType: 'media_server_newsletter', objectId: id, metadata: { recipient } });
    return { ok: true as const };
  }

  async sendNow(id: string, userId?: string) {
    const n = await this.get(id);
    if (!(await this.email.isConfigured())) throw new BadRequestException('Configure email settings first.');
    const recipients = (n.recipientEmails as string[]) ?? [];
    if (recipients.length === 0) throw new BadRequestException('This newsletter has no recipients.');

    const { content, attachments, opts } = await this.build(n);
    const subject = this.subject(n, content);
    const html = renderHtml(content, opts);
    const text = renderText(content, opts);
    this.realtime.broadcast('media_server.newsletter.generated', { id, count: content.totalItems });

    let sent = 0;
    let failed = 0;
    for (const to of recipients) {
      try {
        await this.email.send({ to, subject, html, text, attachments });
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
