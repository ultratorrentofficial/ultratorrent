/**
 * Pure newsletter content + rendering. No IO — grouping and HTML/text
 * generation only, so it is fully unit-testable. All titles/overviews are
 * HTML-escaped. Poster images are referenced by a `cid:` the caller supplies
 * (assembled as email attachments in the service), so the template stays pure.
 *
 * The HTML is a dark, "Tautulli-style" recently-added digest built entirely
 * from tables + inline styles for broad email-client compatibility.
 */

export interface NewsletterItem {
  id?: string;
  title: string;
  mediaType: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  addedAt: Date;
  overview?: string | null;
  rating?: number | null;
  runtime?: number | null; // minutes
  certification?: string | null;
  genres?: string[];
  /** When set, the card renders `<img src="cid:…">`; otherwise a gradient placeholder. */
  posterCid?: string | null;
}

export interface NewsletterSection {
  key: string;
  label: string;
  items: NewsletterItem[];
}

export interface NewsletterContent {
  sections: NewsletterSection[];
  totalItems: number;
  since: Date;
}

const EPISODE_TYPES = ['tv', 'anime', 'episode', 'documentary'];

// Section accent colors (align with the analytics dataviz palette).
const SECTION_ACCENT: Record<string, string> = { movies: '#9085e9', episodes: '#22b8cf', other: '#c98500' };
const TYPE_ACCENT: Record<string, string> = { movie: '#9085e9', tv: '#22b8cf', anime: '#22b8cf', episode: '#22b8cf', documentary: '#199e70', music: '#d55181' };

export function buildSections(items: NewsletterItem[]): NewsletterSection[] {
  const movies = items.filter((i) => i.mediaType === 'movie');
  const episodes = items.filter((i) => EPISODE_TYPES.includes(i.mediaType));
  const other = items.filter((i) => i.mediaType !== 'movie' && !EPISODE_TYPES.includes(i.mediaType));
  const out: NewsletterSection[] = [];
  if (movies.length) out.push({ key: 'movies', label: 'New Movies', items: movies });
  if (episodes.length) out.push({ key: 'episodes', label: 'New TV Episodes', items: episodes });
  if (other.length) out.push({ key: 'other', label: 'Other Additions', items: other });
  return out;
}

export function buildContent(items: NewsletterItem[], since: Date): NewsletterContent {
  return { sections: buildSections(items), totalItems: items.length, since };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function itemTitle(i: NewsletterItem): string {
  const parts = [i.title];
  if (i.year != null) parts.push(`(${i.year})`);
  return parts.join(' ');
}

function episodeTag(i: NewsletterItem): string | null {
  if (i.season == null) return null;
  return `S${String(i.season).padStart(2, '0')}${i.episode != null ? `E${String(i.episode).padStart(2, '0')}` : ''}`;
}

function itemLabel(i: NewsletterItem): string {
  const tag = episodeTag(i);
  return tag ? `${itemTitle(i)} ${tag}` : itemTitle(i);
}

function runtimeLabel(min?: number | null): string | null {
  if (!min || min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

export interface RenderOptions {
  title: string;
  version: string;
  /** Date-range description shown under the title (e.g. "Jul 1 – Jul 6, 2026"). */
  subtitle?: string;
  brand?: string;
  unsubscribeUrl?: string;
}

/** A single "chip" pill (rating/runtime/certification). */
function chip(text: string, color = '#9a9aa8'): string {
  return `<span style="display:inline-block;background:#20202e;color:${color};font:600 11px system-ui,-apple-system,sans-serif;padding:2px 7px;border-radius:99px;margin:0 4px 4px 0;white-space:nowrap">${escapeHtml(text)}</span>`;
}

function posterCell(i: NewsletterItem): string {
  const accent = TYPE_ACCENT[i.mediaType] ?? '#6b6b7a';
  const inner = i.posterCid
    ? `<img src="cid:${escapeHtml(i.posterCid)}" width="92" alt="${escapeHtml(i.title)}" style="display:block;width:92px;height:auto;border-radius:8px;border:1px solid #2a2a3a" />`
    : `<div style="width:92px;height:138px;border-radius:8px;background:linear-gradient(150deg,${accent}55,#1a1a26);border:1px solid #2a2a3a;text-align:center;line-height:138px;color:${accent};font:700 28px system-ui,sans-serif">${escapeHtml((i.title[0] ?? '?').toUpperCase())}</div>`;
  return `<td valign="top" width="104" style="width:104px;padding:0 12px 0 0">${inner}</td>`;
}

function infoCell(i: NewsletterItem): string {
  const accent = TYPE_ACCENT[i.mediaType] ?? '#9a9aa8';
  const tag = episodeTag(i);
  const chips: string[] = [];
  if (i.rating && i.rating > 0) chips.push(chip(`★ ${i.rating.toFixed(1)}`, '#f5c518'));
  const rt = runtimeLabel(i.runtime);
  if (rt) chips.push(chip(rt));
  if (i.certification) chips.push(chip(i.certification));
  if (tag) chips.push(chip(tag, accent));
  const genres = (i.genres ?? []).slice(0, 3).join(' · ');
  const overview = i.overview ? truncate(i.overview, 220) : '';
  return `<td valign="top" style="padding:0">
    <div style="font:700 15px system-ui,-apple-system,sans-serif;color:#f2f2f7;margin:0 0 6px">${escapeHtml(itemTitle(i))}</div>
    ${chips.length ? `<div style="margin:0 0 6px">${chips.join('')}</div>` : ''}
    ${genres ? `<div style="font:600 11px system-ui,sans-serif;color:${accent};letter-spacing:.02em;margin:0 0 6px">${escapeHtml(genres)}</div>` : ''}
    ${overview ? `<div style="font:400 13px/1.5 system-ui,-apple-system,sans-serif;color:#b6b6c4;margin:0">${escapeHtml(overview)}</div>` : ''}
  </td>`;
}

function renderCard(i: NewsletterItem): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;background:#15151f;border:1px solid #23232f;border-radius:12px">
    <tr><td style="padding:14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${posterCell(i)}${infoCell(i)}</tr></table></td></tr>
  </table>`;
}

function renderSection(s: NewsletterSection): string {
  const accent = SECTION_ACCENT[s.key] ?? '#8a8a83';
  return `
  <tr><td style="padding:20px 24px 8px">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="width:4px;background:${accent};border-radius:2px">&nbsp;</td>
      <td style="padding-left:10px;font:700 15px system-ui,-apple-system,sans-serif;color:#f2f2f7">${escapeHtml(s.label)}</td>
      <td style="padding-left:8px;font:600 12px system-ui,sans-serif;color:#8a8a98">${s.items.length}</td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:0 24px">${s.items.map(renderCard).join('')}</td></tr>`;
}

export function renderHtml(content: NewsletterContent, opts: RenderOptions): string {
  const brand = opts.brand ?? 'UltraTorrent';
  const sections = content.sections.map(renderSection).join('');
  const empty = `<tr><td style="padding:32px 24px;text-align:center;font:400 14px system-ui,sans-serif;color:#8a8a98">No new media was added in this period.</td></tr>`;
  const unsub = opts.unsubscribeUrl ? `<a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#8a8a98;text-decoration:underline">Unsubscribe</a> &middot; ` : '';
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="color-scheme" content="dark"/></head>
<body style="margin:0;padding:0;background:#0b0b12">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b12">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#0e0e18;border:1px solid #20202e;border-radius:16px;overflow:hidden">
        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#6d4bd8 0%,#3987e5 100%);padding:28px 24px">
          <div style="font:800 22px system-ui,-apple-system,sans-serif;color:#ffffff;margin:0 0 2px">${escapeHtml(opts.title)}</div>
          ${opts.subtitle ? `<div style="font:500 13px system-ui,sans-serif;color:#e7e0ff;margin:0 0 10px">${escapeHtml(opts.subtitle)}</div>` : ''}
          <div style="display:inline-block;background:rgba(255,255,255,.18);color:#fff;font:700 12px system-ui,sans-serif;padding:4px 10px;border-radius:99px">${content.totalItems} new ${content.totalItems === 1 ? 'addition' : 'additions'}</div>
        </td></tr>
        ${content.totalItems === 0 ? empty : sections}
        <!-- Footer -->
        <tr><td style="padding:8px 24px 24px"><div style="border-top:1px solid #20202e;padding-top:16px;font:400 12px system-ui,sans-serif;color:#6b6b7a">${unsub}Delivered by ${escapeHtml(brand)} &middot; v${escapeHtml(opts.version)}</div></td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function renderText(content: NewsletterContent, opts: RenderOptions): string {
  const lines = [opts.title];
  if (opts.subtitle) lines.push(opts.subtitle);
  lines.push(`${content.totalItems} new ${content.totalItems === 1 ? 'addition' : 'additions'}`, '');
  if (content.totalItems === 0) {
    lines.push('No new media was added in this period.');
  } else {
    for (const s of content.sections) {
      lines.push(`## ${s.label} (${s.items.length})`);
      for (const i of s.items) {
        lines.push(`  - ${itemLabel(i)}`);
        if (i.overview) lines.push(`      ${truncate(i.overview, 160)}`);
      }
      lines.push('');
    }
  }
  lines.push('---', `Delivered by ${opts.brand ?? 'UltraTorrent'} v${opts.version}`);
  if (opts.unsubscribeUrl) lines.push(`Unsubscribe: ${opts.unsubscribeUrl}`);
  return lines.join('\n');
}
