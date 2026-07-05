/**
 * Pure newsletter content + rendering. No IO — grouping and HTML/text
 * generation only, so it is fully unit-testable. Titles are HTML-escaped
 * (content is our own library data, never user HTML).
 */

export interface NewsletterItem {
  title: string;
  mediaType: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  addedAt: Date;
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

function itemLabel(i: NewsletterItem): string {
  const parts = [i.title];
  if (i.year != null) parts.push(`(${i.year})`);
  if (i.season != null) parts.push(`S${String(i.season).padStart(2, '0')}${i.episode != null ? `E${String(i.episode).padStart(2, '0')}` : ''}`);
  return parts.join(' ');
}

export interface RenderOptions {
  title: string;
  version: string;
  unsubscribeUrl?: string;
}

export function renderHtml(content: NewsletterContent, opts: RenderOptions): string {
  const sections = content.sections
    .map(
      (s) => `
    <h2 style="font:600 16px system-ui,sans-serif;color:#111;margin:24px 0 8px">${escapeHtml(s.label)}</h2>
    <ul style="margin:0;padding-left:18px">
      ${s.items.map((i) => `<li style="font:14px system-ui,sans-serif;color:#333;margin:4px 0">${escapeHtml(itemLabel(i))}</li>`).join('')}
    </ul>`,
    )
    .join('');
  const body = content.totalItems === 0
    ? `<p style="font:14px system-ui,sans-serif;color:#666">Nothing new was added in this period.</p>`
    : sections;
  const unsub = opts.unsubscribeUrl
    ? `<a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#888">Unsubscribe</a> · `
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f6f6f6">
  <div style="max-width:600px;margin:0 auto;padding:24px;background:#fff">
    <h1 style="font:700 20px system-ui,sans-serif;color:#111;margin:0 0 4px">${escapeHtml(opts.title)}</h1>
    ${body}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
    <p style="font:12px system-ui,sans-serif;color:#888">${unsub}UltraTorrent v${escapeHtml(opts.version)}</p>
  </div></body></html>`;
}

export function renderText(content: NewsletterContent, opts: RenderOptions): string {
  const lines = [opts.title, ''];
  if (content.totalItems === 0) {
    lines.push('Nothing new was added in this period.');
  } else {
    for (const s of content.sections) {
      lines.push(s.label);
      for (const i of s.items) lines.push(`  - ${itemLabel(i)}`);
      lines.push('');
    }
  }
  lines.push('---', `UltraTorrent v${opts.version}`);
  if (opts.unsubscribeUrl) lines.push(`Unsubscribe: ${opts.unsubscribeUrl}`);
  return lines.join('\n');
}
