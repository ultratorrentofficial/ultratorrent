import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { paginate, parsePage } from '../../common/pagination';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { MODULE_IDS } from '@ultratorrent/shared';
import type { MediaServerNewsletter } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ModuleRegistryService } from '../module-registry/module-registry.service';
import { MediaServerEmailService, type EmailAttachment } from './media-server-email.service';
import { NewsletterImageService, type PosterArt } from './newsletter-image.service';
import { buildContent, renderHtml, renderText, sampleContent, NEWSLETTER_GROUPS, type NewsletterContent, type NewsletterItem, type RenderOptions } from './newsletter-render';
import { newsletterStrings } from './newsletter-strings';
import {
  BRAND_LOGO_CID, BRAND_LOGO_CONTENT_TYPE, BRAND_LOGO_HEIGHT, BRAND_LOGO_PNG_BASE64, BRAND_LOGO_WIDTH,
} from './newsletter-brand-logo';
import { inlineCidImages } from './newsletter-inline-cid';
import { nextRunAt } from './newsletter-schedule';

const ACCENT = '#f5a623';

interface NewsletterInput {
  name?: string;
  brandTitle?: string | null;
  enabled?: boolean;
  frequency?: string;
  recipientEmails?: string[];
  contentSections?: string[];
  subjectTemplate?: string;
  dateRangeMode?: string;
  lastDays?: number;
  startDate?: string | null;
  /** 0=Sunday … 6=Saturday; null keeps the legacy relative cadence. */
  sendWeekday?: number | null;
  sendHour?: number;
  sendMinute?: number;
  timezone?: string;
}

/** Where the "powered by" credit in the footer points. */
const SOURCE_URL = 'https://github.com/damirabal/ultratorrent-core';
const MAX_ITEMS = 60; // items rendered in the email
const MAX_POSTERS = 30; // posters per email (keeps a CID-attached email a sane size)

/** Media types whose episodes render as grouped shows (see NEWSLETTER_GROUPS). */
const TV_MEDIA_TYPES = new Set<string>(NEWSLETTER_GROUPS.find((g) => g.key === 'tv')!.types);
/** Artwork types accepted for a show poster, in preference order (best first). */
const SHOW_POSTER_TYPES = ['poster', 'season_poster', 'thumbnail', 'fanart'];

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
    private readonly images: NewsletterImageService,
    private readonly config: ConfigService,
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
        brandTitle: input.brandTitle?.trim() || null,
        enabled: input.enabled ?? true,
        frequency: input.frequency ?? 'weekly',
        recipientEmails: (input.recipientEmails ?? []) as object,
        contentSections: (input.contentSections ?? ['movies', 'episodes']) as object,
        subjectTemplate: input.subjectTemplate,
        dateRangeMode: input.dateRangeMode ?? 'since_last_send',
        lastDays: input.lastDays ?? 7,
        startDate: input.startDate ? new Date(input.startDate) : null,
        sendWeekday: input.sendWeekday ?? null,
        sendHour: input.sendHour ?? 9,
        sendMinute: input.sendMinute ?? 0,
        timezone: input.timezone ?? 'UTC',
        /*
         * Scheduled from birth. Without this `nextRunAt` stayed NULL, and the
         * dispatcher selects on `nextRunAt <= now`, which NULL never satisfies
         * — so a newsletter created and left alone never sent at all. Both of
         * one live host's weekly newsletters sat enabled and idle because of
         * it; the other host's only ran because someone pressed Send once.
         */
        nextRunAt: nextRunAt({
          frequency: input.frequency ?? 'weekly',
          sendWeekday: input.sendWeekday ?? null,
          sendHour: input.sendHour ?? 9,
          sendMinute: input.sendMinute ?? 0,
          timezone: input.timezone ?? 'UTC',
        }, new Date()),
      },
    });
    await this.audit.record({ userId, action: 'media_server_analytics.newsletter.created', objectType: 'media_server_newsletter', objectId: row.id });
    return row;
  }

  async update(id: string, input: NewsletterInput, userId?: string) {
    const current = await this.get(id);
    const data: Record<string, unknown> = {};
    for (const k of ['name', 'enabled', 'frequency', 'subjectTemplate', 'dateRangeMode', 'lastDays',
      'sendWeekday', 'sendHour', 'sendMinute', 'timezone'] as const) {
      if (input[k] !== undefined) data[k] = input[k];
    }
    // Blank means "use the default title", which is NULL — not an empty header.
    if (input.brandTitle !== undefined) data.brandTitle = input.brandTitle?.trim() || null;
    if (input.startDate !== undefined) data.startDate = input.startDate ? new Date(input.startDate) : null;
    if (input.recipientEmails !== undefined) data.recipientEmails = input.recipientEmails as object;
    if (input.contentSections !== undefined) data.contentSections = input.contentSections as object;

    /*
     * Re-aim the next slot whenever the schedule itself changes. Without this,
     * moving a newsletter from Friday to Monday would still fire on Friday —
     * once — because `nextRunAt` is only restamped after a send, and the
     * operator would reasonably read the change as having taken effect.
     */
    const SCHEDULE_KEYS = ['frequency', 'sendWeekday', 'sendHour', 'sendMinute', 'timezone'] as const;
    if (SCHEDULE_KEYS.some((k) => input[k] !== undefined)) {
      const merged = { ...current, ...data } as {
        frequency: string;
        sendWeekday?: number | null;
        sendHour?: number | null;
        sendMinute?: number | null;
        timezone?: string | null;
      };
      data.nextRunAt = nextRunAt(merged, new Date());
    }

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
  private async renderOpts(since: Date, until: Date, n?: MediaServerNewsletter): Promise<RenderOptions> {
    return {
      strings: newsletterStrings('en-US'),
      // Read from config, never a literal. This was a hardcoded '0.15.0' that
      // stayed put through forty releases, so every email shipped claiming a
      // version the product had not been for a year.
      version: this.config.get<string>('node.productVersion') ?? '0.0.0',
      brandTitle: n?.brandTitle ?? null,
      sourceUrl: SOURCE_URL,
      serverName: await this.serverName(),
      logoCid: BRAND_LOGO_CID,
      logoWidth: BRAND_LOGO_WIDTH,
      logoHeight: BRAND_LOGO_HEIGHT,
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
  /** Media types this newsletter covers (from `contentSections`); null = everything. */
  private mediaTypeFilter(n: MediaServerNewsletter): string[] | null {
    const selected = (n.contentSections as string[] | null) ?? [];
    const keys = new Set(selected);
    if (keys.size === 0) return null;
    const types = NEWSLETTER_GROUPS.filter((g) => keys.has(g.key)).flatMap((g) => g.types as readonly string[]);
    return types.length ? [...new Set(types)] : null;
  }

  private async build(n: MediaServerNewsletter): Promise<RenderedNewsletter> {
    const since = this.since(n);
    const until = new Date();
    const types = this.mediaTypeFilter(n);
    const rows = await this.prisma.mediaItem.findMany({
      where: { createdAt: { gte: since }, ...(types ? { mediaType: { in: types } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: MAX_ITEMS,
      select: {
        id: true, title: true, mediaType: true, year: true, season: true, episode: true, createdAt: true,
        library: { select: { name: true } },
        metadata: { select: { overview: true, rating: true, runtime: true, certification: true, genres: true } },
        artwork: { where: { type: 'poster' }, orderBy: { selected: 'desc' }, take: 1, select: { id: true, url: true, localPath: true } },
      },
    });

    // Episodes are frequently stored with a raw release title ("Show - S02E01 -
    // Name") and null season/episode when imported unidentified. Normalize the
    // show name + S/E from the title so those episodes collapse into one show
    // (and match the library's real show item for artwork), reusing the RSS
    // release-name parser.
    const { parseTorrentName } = await import('../rss/torrent-name-parser');

    const posters = new Map<string, PosterArt>();
    const items: NewsletterItem[] = rows.map((r) => {
      if (r.artwork[0]) posters.set(r.id, r.artwork[0]);
      let title = r.title;
      let season = r.season;
      let episode = r.episode;
      if (TV_MEDIA_TYPES.has(r.mediaType)) {
        const p = parseTorrentName(r.title);
        if (p.title && (p.season != null || p.episode != null)) {
          title = p.title;
          season = season ?? p.season;
          episode = episode ?? p.episode;
        }
      }
      const g = r.metadata?.genres;
      return {
        id: r.id,
        title,
        mediaType: r.mediaType,
        year: r.year,
        season,
        episode,
        addedAt: r.createdAt,
        overview: r.metadata?.overview ?? null,
        rating: r.metadata?.rating ?? null,
        runtime: r.metadata?.runtime ?? null,
        certification: r.metadata?.certification ?? null,
        genres: Array.isArray(g) ? (g as string[]) : [],
        library: r.library?.name ?? null,
      };
    });

    // The conjunction in "E02, E04 and E09" is localized like every other label.
    const content = buildContent(items, since, until, newsletterStrings('en-US').and);
    // Resolve each show's poster from the whole library by its (normalized)
    // title — the newest episodes are often artwork-less, but the show's real
    // item carries the poster.
    const showTitles = [
      ...new Set(content.sections.filter((s) => s.layout === 'shows').flatMap((s) => s.shows.map((sh) => sh.title))),
    ];
    const showPosters = await this.fetchShowPosters(showTitles);
    const attachments = await this.assemblePosters(content, posters, showPosters);
    // The logo rides along with the posters so preview and send share one path
    // and it never competes with them for the MAX_POSTERS budget.
    attachments.unshift({
      cid: BRAND_LOGO_CID,
      filename: `${BRAND_LOGO_CID}.png`,
      content: Buffer.from(BRAND_LOGO_PNG_BASE64, 'base64'),
      contentType: BRAND_LOGO_CONTENT_TYPE,
    });
    return { content, attachments, opts: await this.renderOpts(since, until, n) };
  }

  /**
   * Best show poster from the library for each (normalized) show title, trying
   * `poster` → `season_poster` → `thumbnail` → `fanart` and preferring a
   * selected artwork with a usable path/URL. Lets an artwork-less recent episode
   * still show its show's poster.
   */
  private async fetchShowPosters(titles: string[]): Promise<Map<string, PosterArt>> {
    const chosen = new Map<string, PosterArt>();
    if (titles.length === 0) return chosen;
    const arts = await this.prisma.mediaArtwork.findMany({
      where: {
        type: { in: SHOW_POSTER_TYPES },
        OR: [{ localPath: { not: null } }, { url: { not: null } }],
        item: { title: { in: titles }, mediaType: { in: [...TV_MEDIA_TYPES] } },
      },
      select: { id: true, url: true, localPath: true, type: true, selected: true, item: { select: { title: true } } },
    });
    // Lower score = better: earlier type in the preference list, selected first.
    const score = (type: string, selected: boolean) => SHOW_POSTER_TYPES.indexOf(type) * 2 + (selected ? 0 : 1);
    const best = new Map<string, number>();
    for (const a of arts) {
      const t = a.item.title;
      const s = score(a.type, a.selected);
      if (!best.has(t) || s < best.get(t)!) {
        best.set(t, s);
        chosen.set(t, { id: a.id, url: a.url, localPath: a.localPath });
      }
    }
    return chosen;
  }

  /**
   * Resolve one poster per show + per movie and stamp it onto the content in the
   * admin-chosen hosting mode: a signed self-hosted URL (`posterUrl`, no bytes
   * sent), an external-host upload (`posterUrl`), or an embedded CID attachment
   * (`posterCid`, the returned attachments). Best-effort per poster.
   */
  private async assemblePosters(
    content: NewsletterContent,
    posters: Map<string, PosterArt>,
    showPosters: Map<string, PosterArt>,
  ): Promise<EmailAttachment[]> {
    // One poster per show (by show title, falling back to the representative
    // item) + per movie (by id), across all sections, in render order, capped.
    type Target = { art?: PosterArt; setCid: (cid: string) => void; setUrl: (url: string) => void };
    const bySection: Target[][] = content.sections.map((sec) => [
        ...sec.shows.map((s) => ({
          art: showPosters.get(s.title) ?? (s.posterItemId ? posters.get(s.posterItemId) : undefined),
          setCid: (cid: string) => (s.posterCid = cid),
          setUrl: (url: string) => (s.posterUrl = url),
        })),
        ...sec.movies.map((m) => ({
          art: m.id ? posters.get(m.id) : undefined,
          setCid: (cid: string) => (m.posterCid = cid),
          setUrl: (url: string) => (m.posterUrl = url),
        })),
      ]);
    const targets: Target[] = bySection.flat();

    /*
     * Spend the poster budget across sections, not first-come.
     *
     * Targets are built in render order, so TV comes first and a busy week of
     * television exhausted MAX_POSTERS before a single film was reached —
     * measured on a real library: exactly 30 distinct shows in the window
     * against a cap of 30, leaving every movie without art. Interleaving takes
     * one from each section in turn, so a section is only starved when the
     * budget genuinely cannot cover the sections.
     */
    const interleaved: typeof targets = [];
    for (let i = 0; interleaved.length < targets.length; i += 1) {
      let progressed = false;
      for (const group of bySection) {
        if (i < group.length) { interleaved.push(group[i]); progressed = true; }
      }
      if (!progressed) break;
    }

    const { mode, publicBaseUrl } = await this.images.effectiveMode();
    const attachments: EmailAttachment[] = [];
    let used = 0;
    for (const tgt of interleaved) {
      if (used >= MAX_POSTERS) break;
      if (!tgt.art) continue;

      // Self-hosted: just link to the signed image endpoint (no bytes needed).
      if (mode === 'self_hosted' && publicBaseUrl) {
        tgt.setUrl(this.images.imageUrl(publicBaseUrl, tgt.art.id));
        used++;
        continue;
      }

      const loaded = await this.images.loadAndResize(tgt.art);
      if (!loaded) continue;

      // External host: upload the downscaled bytes, link to the returned URL.
      if (mode === 'external') {
        const url = await this.images.uploadExternal(loaded.buf);
        if (!url) continue;
        tgt.setUrl(url);
        used++;
        continue;
      }

      // Default (attach): embed as a CID inline attachment.
      const cid = `nlposter-${attachments.length}`;
      const ext = loaded.contentType.includes('png') ? 'png' : 'jpg';
      attachments.push({ cid, filename: `${cid}.${ext}`, content: loaded.buf, contentType: loaded.contentType });
      tgt.setCid(cid);
      used++;
    }
    return attachments;
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
    // Sample mode drops the poster attachments (the sample content references
    // none) but must KEEP the logo, or the header renders an unresolvable
    // `cid:` — a broken image in the one view whose job is to show the styling.
    const attachments = isSample
      ? built.attachments.filter((a) => a.cid === BRAND_LOGO_CID)
      : built.attachments;
    /*
     * The in-app preview iframe can't resolve `cid:` refs, so inline the bytes
     * as data URIs — a faithful, self-contained preview of the sent email.
     * Sent mail keeps the `cid:` refs and is unaffected; see the substitution's
     * own notes for why it must not be done one attachment at a time.
     */
    const html = inlineCidImages(renderHtml(content, built.opts), attachments);
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

    await this.prisma.mediaServerNewsletter.update({ where: { id }, data: { lastSuccessfulSendAt: new Date(), nextRunAt: this.nextRun(n) } });
    this.realtime.broadcast(failed && !sent ? 'media_server.newsletter.failed' : 'media_server.newsletter.sent', { id, sent, failed });
    await this.audit.record({ userId, action: 'media_server_analytics.newsletter.sent', objectType: 'media_server_newsletter', objectId: id, metadata: { sent, failed } });
    return { sent, failed };
  }

  /**
   * The newsletter's next slot, from its own schedule.
   *
   * Computed against the calendar rather than "now + 7 days", so a send that
   * runs late does not drag every future send later with it.
   */
  private nextRun(n: {
    frequency: string;
    sendWeekday?: number | null;
    sendHour?: number | null;
    sendMinute?: number | null;
    timezone?: string | null;
  }, from = new Date()): Date | null {
    return nextRunAt(n, from);
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
