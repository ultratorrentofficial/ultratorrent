/**
 * Pure newsletter content + rendering — no IO, so it is fully unit-testable.
 * Produces an original UltraTorrent dark "media digest" email: a centered
 * container, amber accents, a branded header, section headers with count
 * summaries, poster-left TV show cards, a movie poster grid, 5-star ratings,
 * metadata badges and a three-area footer. Built entirely from tables + inline
 * styles (plus a small `<style>` block for mobile) for broad email-client
 * compatibility. All user text is HTML-escaped; all labels are injected via
 * {@link NewsletterStrings} (no hardcoded user-facing strings).
 *
 * Inspired by the visual structure of a modern media-server digest — original
 * markup and branding, no third-party code or assets.
 */

// --- palette -------------------------------------------------------------
const C = {
  page: '#0b0b12',
  card: '#15151f',
  cardAlt: '#1a1a26',
  border: '#26263a',
  divider: '#2a2a3a',
  text: '#f4f4f8',
  muted: '#9a9aa8',
  faint: '#6b6b7a',
  amber: '#f5a623',
  starEmpty: '#3a3a44',
  badgeBg: '#23232f',
  badgeText: '#c9c9d4',
} as const;

const TV_TYPES = ['tv', 'anime', 'episode', 'documentary'];

// --- types ---------------------------------------------------------------
export interface NewsletterItem {
  id?: string;
  title: string;
  mediaType: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  addedAt: Date;
  overview?: string | null;
  rating?: number | null; // provider scale, 0–10
  runtime?: number | null; // minutes
  certification?: string | null;
  genres?: string[];
  library?: string | null;
  upgraded?: boolean;
  posterCid?: string | null;
}

/** A recently-added TV show: episodes grouped under one show. */
export interface NewsletterShow {
  title: string;
  year: number | null;
  overview?: string | null;
  rating?: number | null;
  runtime?: number | null;
  genres?: string[];
  library?: string | null;
  episodeCount: number;
  seasonCount: number;
  seasonRange: string; // e.g. "S03" or "S01–S03"
  episodeRange: string; // e.g. "E01–E05"
  /** Item id whose artwork represents the show (used by the poster proxy). */
  posterItemId?: string;
  posterCid?: string | null;
}

export interface NewsletterContent {
  shows: NewsletterShow[];
  movies: NewsletterItem[];
  episodeCount: number;
  totalItems: number;
  since: Date;
  until: Date;
}

/** All localized strings the template needs (see `newsletter-strings.ts`). */
export interface NewsletterStrings {
  brandTitle: string; // "ULTRATORRENT NEWSLETTER"
  tvShowsTitle: string;
  moviesTitle: string;
  shows: string; // "Shows"
  episodes: string; // "Episodes"
  movies: string; // "Movies"
  seasonsOne: string; // "Season {{n}}"
  seasonsRange: string; // "Seasons {{a}}–{{b}}"
  empty: string;
  unrated: string;
  unsubscribe: string;
  unsubscribeNote: string;
  preferences: string;
  preferencesNote: string;
  tagline: string;
  deliveredBy: string;
}

export interface RenderStyle {
  showRatings?: boolean;
  showGenres?: boolean;
  showRuntime?: boolean;
  showOverview?: boolean;
  showLibraryBadges?: boolean;
  showUpgradeBadges?: boolean;
  accent?: string;
  maxItemsPerSection?: number;
}

export interface RenderOptions {
  strings: NewsletterStrings;
  version: string;
  serverName?: string;
  dateRange?: string; // "2026-06-26 - 2026-07-03"
  brand?: string; // footer product name, default "UltraTorrent"
  instanceUrl?: string;
  unsubscribeUrl?: string;
  preferencesUrl?: string;
  style?: RenderStyle;
}

// --- helpers -------------------------------------------------------------
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function interp(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => escapeHtml(String(vars[k] ?? '')));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
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

// --- content assembly (pure, testable) -----------------------------------
export function groupShows(items: NewsletterItem[]): NewsletterShow[] {
  const byTitle = new Map<string, NewsletterItem[]>();
  for (const it of items) {
    if (!byTitle.has(it.title)) byTitle.set(it.title, []);
    byTitle.get(it.title)!.push(it);
  }
  const shows: NewsletterShow[] = [];
  for (const [title, eps] of byTitle) {
    const seasons = [...new Set(eps.map((e) => e.season).filter((s): s is number => s != null))].sort((a, b) => a - b);
    const episodes = eps.map((e) => e.episode).filter((e): e is number => e != null);
    const ratings = eps.map((e) => e.rating).filter((r): r is number => r != null && r > 0);
    shows.push({
      title,
      year: eps.map((e) => e.year).filter((y): y is number => y != null).sort((a, b) => a - b)[0] ?? null,
      overview: eps.find((e) => e.overview)?.overview ?? null,
      rating: ratings.length ? ratings.reduce((s, r) => s + r, 0) / ratings.length : null,
      runtime: eps.find((e) => e.runtime)?.runtime ?? null,
      genres: [...new Set(eps.flatMap((e) => e.genres ?? []))].slice(0, 3),
      library: eps.find((e) => e.library)?.library ?? null,
      episodeCount: eps.length,
      seasonCount: seasons.length,
      seasonRange: seasons.length <= 1 ? `S${pad2(seasons[0] ?? 1)}` : `S${pad2(seasons[0])}–S${pad2(seasons[seasons.length - 1])}`,
      episodeRange: episodes.length ? `E${pad2(Math.min(...episodes))}–E${pad2(Math.max(...episodes))}` : '',
      posterItemId: (eps.find((e) => e.posterCid) ?? eps[0])?.id,
    });
  }
  return shows.sort((a, b) => b.episodeCount - a.episodeCount);
}

export function buildContent(items: NewsletterItem[], since: Date, until: Date): NewsletterContent {
  const movies = items.filter((i) => i.mediaType === 'movie');
  const tvItems = items.filter((i) => TV_TYPES.includes(i.mediaType));
  return { shows: groupShows(tvItems), movies, episodeCount: tvItems.length, totalItems: items.length, since, until };
}

// --- component renderers -------------------------------------------------
/** Normalize a 0–10 provider rating to a 5-star visual; '' when unrated. */
export function renderRating(rating: number | null | undefined, accent: string): string {
  if (rating == null || rating <= 0) return '';
  const filled = Math.max(0, Math.min(5, Math.round(rating / 2)));
  let stars = '';
  for (let i = 0; i < 5; i++) stars += `<span style="color:${i < filled ? accent : C.starEmpty};font-size:14px;line-height:1">★</span>`;
  return `<span style="white-space:nowrap">${stars} <span style="color:${C.muted};font:600 11px system-ui,-apple-system,sans-serif">${rating.toFixed(1)}</span></span>`;
}

function badge(text: string): string {
  return `<span style="display:inline-block;background:${C.badgeBg};color:${C.badgeText};font:600 11px system-ui,-apple-system,sans-serif;padding:2px 8px;border-radius:6px;margin:0 4px 4px 0;white-space:nowrap">${escapeHtml(text)}</span>`;
}

export function renderBadges(badges: string[]): string {
  return badges.filter(Boolean).map((b) => badge(b)).join('');
}

function poster(cid: string | null | undefined, initial: string, w: number, accent: string): string {
  const h = Math.round(w * 1.5);
  if (cid) {
    return `<img src="cid:${escapeHtml(cid)}" width="${w}" alt="" style="display:block;width:${w}px;max-width:100%;height:auto;border-radius:8px;border:1px solid ${C.divider}" />`;
  }
  return `<div style="width:${w}px;height:${h}px;border-radius:8px;background:${C.cardAlt};border:1px solid ${C.divider};text-align:center;line-height:${h}px;color:${accent};font:700 ${Math.round(w / 3)}px system-ui,-apple-system,sans-serif">${escapeHtml(initial.toUpperCase())}</div>`;
}

function sectionHeader(icon: string, title: string, countHtml: string): string {
  return `
  <tr><td style="padding:24px 24px 12px">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
      <td width="28" valign="top" style="font-size:18px;line-height:1.2">${icon}</td>
      <td valign="top">
        <div style="font:700 16px system-ui,-apple-system,sans-serif;color:${C.text}">${escapeHtml(title)}</div>
        <div style="margin-top:2px;font:600 12px system-ui,-apple-system,sans-serif;color:${C.muted}">${countHtml}</div>
      </td>
    </tr></table>
    <div style="height:1px;background:${C.divider};margin-top:12px"></div>
  </td></tr>`;
}

function countSummary(parts: { n: number; label: string }[], accent: string): string {
  return parts
    .map((p) => `<span style="color:${accent};font-weight:700">${p.n}</span> <span style="color:${C.muted}">${escapeHtml(p.label)}</span>`)
    .join(' <span style="color:' + C.faint + '">/</span> ');
}

function tvCard(show: NewsletterShow, opts: RenderOptions): string {
  const style = opts.style ?? {};
  const accent = style.accent ?? C.amber;
  const badges: string[] = [];
  if (show.year != null) badges.push(String(show.year));
  badges.push(`${show.seasonRange}${show.episodeRange ? ` · ${show.episodeRange}` : ''}`);
  if (style.showRuntime !== false) { const rt = runtimeLabel(show.runtime); if (rt) badges.push(rt); }
  if (style.showGenres !== false && show.genres?.length) badges.push(show.genres.join(' · '));
  if (style.showLibraryBadges && show.library) badges.push(show.library);
  const rating = style.showRatings !== false ? renderRating(show.rating, accent) : '';
  const overview = style.showOverview !== false && show.overview ? truncate(show.overview, 160) : '';

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.border};border-radius:12px">
    <tr><td style="padding:12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="top" width="84" style="width:84px;padding-right:12px">${poster(show.posterCid, show.title[0] ?? '?', 84, accent)}</td>
      <td valign="top">
        <div style="font:700 14px system-ui,-apple-system,sans-serif;color:${C.text};margin-bottom:2px">${escapeHtml(show.title)}</div>
        <div style="font:600 12px system-ui,-apple-system,sans-serif;color:${accent};margin-bottom:6px">${show.episodeCount} ${escapeHtml(opts.strings.episodes)}</div>
        ${overview ? `<div style="font:400 12px/1.5 system-ui,-apple-system,sans-serif;color:${C.muted};margin-bottom:8px">${escapeHtml(overview)}</div>` : ''}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="bottom">${renderBadges(badges)}</td>
          <td valign="bottom" align="right" style="white-space:nowrap">${rating}</td>
        </tr></table>
      </td>
    </tr></table></td></tr>
  </table>`;
}

function tvGrid(shows: NewsletterShow[], opts: RenderOptions): string {
  const rows: string[] = [];
  for (let i = 0; i < shows.length; i += 2) {
    const left = tvCard(shows[i], opts);
    const right = shows[i + 1] ? tvCard(shows[i + 1], opts) : '';
    rows.push(`<tr>
      <td class="col" valign="top" width="50%" style="padding:0 6px 12px 0">${left}</td>
      <td class="col" valign="top" width="50%" style="padding:0 0 12px 6px">${right}</td>
    </tr>`);
  }
  return `<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join('')}</table></td></tr>`;
}

function movieCard(m: NewsletterItem, opts: RenderOptions): string {
  const style = opts.style ?? {};
  const accent = style.accent ?? C.amber;
  const rt = style.showRuntime !== false ? runtimeLabel(m.runtime) : null;
  const rating = style.showRatings !== false ? renderRating(m.rating, accent) : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.border};border-radius:12px">
    <tr><td align="center" style="padding:12px 12px 8px">${poster(m.posterCid, m.title[0] ?? '?', 120, accent)}</td></tr>
    <tr><td style="padding:0 12px 12px;text-align:center">
      <div style="font:700 13px system-ui,-apple-system,sans-serif;color:${C.text}">${escapeHtml(m.title)}</div>
      <div style="font:600 11px system-ui,-apple-system,sans-serif;color:${C.muted};margin-top:2px">${[m.year, rt].filter(Boolean).join(' · ')}</div>
      ${rating ? `<div style="margin-top:6px">${rating}</div>` : ''}
    </td></tr>
  </table>`;
}

function movieGrid(movies: NewsletterItem[], opts: RenderOptions): string {
  const rows: string[] = [];
  for (let i = 0; i < movies.length; i += 2) {
    const left = movieCard(movies[i], opts);
    const right = movies[i + 1] ? movieCard(movies[i + 1], opts) : '';
    rows.push(`<tr>
      <td class="col" valign="top" width="50%" style="padding:0 6px 12px 0">${left}</td>
      <td class="col" valign="top" width="50%" style="padding:0 0 12px 6px">${right}</td>
    </tr>`);
  }
  return `<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join('')}</table></td></tr>`;
}

function header(content: NewsletterContent, opts: RenderOptions): string {
  const accent = opts.style?.accent ?? C.amber;
  return `<tr><td style="padding:32px 24px 0;text-align:center">
    <div style="display:inline-block;width:36px;height:36px;line-height:36px;border-radius:9px;background:${accent};color:#151515;font:800 16px system-ui,-apple-system,sans-serif;margin-bottom:12px">UT</div>
    <div style="font:800 20px/1.2 system-ui,-apple-system,sans-serif;color:${C.text};letter-spacing:.08em">${escapeHtml(opts.strings.brandTitle)}</div>
    ${opts.serverName ? `<div style="margin-top:10px;font:700 14px system-ui,-apple-system,sans-serif;color:${C.text};letter-spacing:.04em;text-transform:uppercase">${escapeHtml(opts.serverName)}</div>` : ''}
    ${opts.dateRange ? `<div style="margin-top:4px;font:500 13px system-ui,-apple-system,sans-serif;color:${C.muted}">${escapeHtml(opts.dateRange)}</div>` : ''}
    <div style="height:2px;background:${accent};max-width:120px;margin:16px auto 0;border-radius:2px"></div>
  </td></tr>`;
}

function footer(opts: RenderOptions): string {
  const brand = opts.brand ?? 'UltraTorrent';
  const link = (href: string | undefined, text: string) =>
    href ? `<a href="${escapeHtml(href)}" style="color:${C.muted};text-decoration:underline">${escapeHtml(text)}</a>` : escapeHtml(text);
  const cell = (align: string, html: string) =>
    `<td class="fcol" valign="top" width="33%" align="${align}" style="padding:4px 8px;font:400 11px/1.5 system-ui,-apple-system,sans-serif;color:${C.faint}">${html}</td>`;
  return `<tr><td style="padding:8px 24px 28px">
    <div style="height:1px;background:${C.divider};margin-bottom:16px"></div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${cell('left', `${link(opts.unsubscribeUrl, opts.strings.unsubscribe)}<div style="margin-top:2px">${escapeHtml(opts.strings.unsubscribeNote)}</div>`)}
      ${cell('center', `<div style="color:${C.text};font-weight:700">${escapeHtml(brand)}</div><div>${escapeHtml(opts.strings.tagline)}</div>${opts.instanceUrl ? `<div><a href="${escapeHtml(opts.instanceUrl)}" style="color:${opts.style?.accent ?? C.amber};text-decoration:none">${escapeHtml(opts.instanceUrl)}</a></div>` : ''}`)}
      ${cell('right', `${link(opts.preferencesUrl, opts.strings.preferences)}<div style="margin-top:2px">${escapeHtml(opts.strings.preferencesNote)}</div>`)}
    </tr></table>
    <div style="text-align:center;margin-top:14px;color:${C.faint};font:400 10px system-ui">${escapeHtml(opts.strings.deliveredBy)} ${escapeHtml(brand)} · v${escapeHtml(opts.version)}</div>
  </td></tr>`;
}

const MOBILE_STYLE = `@media only screen and (max-width:600px){
  .container{width:100%!important}
  .col{display:block!important;width:100%!important;padding:0 0 12px 0!important}
  .fcol{display:block!important;width:100%!important;text-align:center!important;padding:6px 0!important}
}`;

export function renderHtml(content: NewsletterContent, opts: RenderOptions): string {
  const accent = opts.style?.accent ?? C.amber;
  const cap = opts.style?.maxItemsPerSection ?? 24;
  const s = opts.strings;
  const sections: string[] = [];

  if (content.shows.length) {
    sections.push(sectionHeader('📺', s.tvShowsTitle, countSummary([{ n: content.shows.length, label: s.shows }, { n: content.episodeCount, label: s.episodes }], accent)));
    sections.push(tvGrid(content.shows.slice(0, cap), opts));
  }
  if (content.movies.length) {
    sections.push(sectionHeader('🎬', s.moviesTitle, countSummary([{ n: content.movies.length, label: s.movies }], accent)));
    sections.push(movieGrid(content.movies.slice(0, cap), opts));
  }
  const empty = `<tr><td style="padding:40px 24px;text-align:center;font:400 14px system-ui,-apple-system,sans-serif;color:${C.muted}">${escapeHtml(s.empty)}</td></tr>`;

  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="color-scheme" content="dark"/><style>${MOBILE_STYLE}</style></head>
<body style="margin:0;padding:0;background:${C.page}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page}">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" class="container" width="720" cellpadding="0" cellspacing="0" style="width:720px;max-width:100%;background:${C.page};border:1px solid ${C.border};border-radius:16px;overflow:hidden">
        ${header(content, opts)}
        ${content.totalItems === 0 ? empty : sections.join('')}
        ${footer(opts)}
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/** Representative sample content for the preview when the library has no new items. */
export function sampleContent(): NewsletterContent {
  const now = new Date();
  const shows: NewsletterShow[] = [
    { title: 'Silverpeak', year: 2024, overview: 'A frontier town keeps a secret buried under the snow.', rating: 8.4, runtime: 52, genres: ['Drama', 'Mystery'], episodeCount: 8, seasonCount: 1, seasonRange: 'S01', episodeRange: 'E01–E08' },
    { title: 'Orbital', year: 2023, overview: 'Six astronauts, one failing station, zero room for error.', rating: 7.9, runtime: 48, genres: ['Sci-Fi', 'Thriller'], episodeCount: 5, seasonCount: 1, seasonRange: 'S02', episodeRange: 'E01–E05' },
  ];
  const movies: NewsletterItem[] = [
    { title: 'The Long Night', mediaType: 'movie', year: 2024, season: null, episode: null, addedAt: now, rating: 8.1, runtime: 124, genres: ['Drama'] },
    { title: 'Afterglow', mediaType: 'movie', year: 2023, season: null, episode: null, addedAt: now, rating: 7.2, runtime: 98, genres: ['Romance'] },
  ];
  return { shows, movies, episodeCount: 13, totalItems: 15, since: new Date(now.getTime() - 7 * 864e5), until: now };
}

export function renderText(content: NewsletterContent, opts: RenderOptions): string {
  const s = opts.strings;
  const lines = [s.brandTitle];
  if (opts.serverName) lines.push(opts.serverName);
  if (opts.dateRange) lines.push(opts.dateRange);
  lines.push('');
  if (content.totalItems === 0) {
    lines.push(s.empty);
  } else {
    if (content.shows.length) {
      lines.push(`## ${s.tvShowsTitle} — ${content.shows.length} ${s.shows} / ${content.episodeCount} ${s.episodes}`);
      for (const show of content.shows) {
        lines.push(`  - ${show.title}${show.year ? ` (${show.year})` : ''} — ${show.episodeCount} ${s.episodes} · ${show.seasonRange}${show.rating ? ` · ★${show.rating.toFixed(1)}` : ''}`);
        if (opts.style?.showOverview !== false && show.overview) lines.push(`      ${truncate(show.overview, 140)}`);
      }
      lines.push('');
    }
    if (content.movies.length) {
      lines.push(`## ${s.moviesTitle} — ${content.movies.length} ${s.movies}`);
      for (const m of content.movies) {
        lines.push(`  - ${m.title}${m.year ? ` (${m.year})` : ''}${m.rating ? ` · ★${m.rating.toFixed(1)}` : ''}`);
      }
      lines.push('');
    }
  }
  lines.push('---', `${s.deliveredBy} ${opts.brand ?? 'UltraTorrent'} v${opts.version}`);
  if (opts.unsubscribeUrl) lines.push(`${s.unsubscribe}: ${opts.unsubscribeUrl}`);
  return lines.join('\n');
}
