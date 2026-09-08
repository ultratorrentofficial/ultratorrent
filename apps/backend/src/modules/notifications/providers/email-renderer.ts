import { splitSummary, type NotificationPresentation } from '@ultratorrent/shared';

/** Accent → hex, for email. Inline styles only; clients strip `<style>`. */
const ACCENT_HEX: Record<string, string> = {
  started: '#22c55e',
  stopped: '#f43f5e',
  success: '#22c55e',
  warning: '#f59e0b',
  error: '#dc2626',
  neutral: '#64748b',
};

/** Escape the five characters that would otherwise be markup. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The plain-text part.
 *
 * Not a fallback nobody reads: some clients prefer it, and it is what a screen
 * reader or a text-only relay sees. It carries the same facts in the same order
 * as the HTML, so the two cannot disagree.
 */
export function renderEmailText(p: NotificationPresentation): string {
  const lines = [`${p.headline.lead} ${p.headline.trail}`, '', p.summary.text];
  if (p.facts.length) {
    lines.push('');
    for (const fact of p.facts) lines.push(`${fact.label}: ${fact.value}`);
  }
  /*
   * The digest, in the same order as the HTML. A text-only reader gets the same
   * titles with the same synopses — everything the poster adds is decoration on
   * top of this, not information only the HTML has.
   */
  for (const item of p.items ?? []) {
    lines.push('', `• ${item.title}${item.subtitle ? ` (${item.subtitle})` : ''}`);
    if (item.note) lines.push(`  ${item.note}`);
    for (const f of item.facts ?? []) lines.push(`  ${f.label}: ${f.value}`);
    if (item.synopsis) lines.push(`  ${item.synopsis}`);
  }
  if (p.progress) lines.push('', p.progress.label);
  lines.push('', '—', 'UltraTorrent');
  return lines.join('\n');
}

/**
 * The HTML part.
 *
 * Table-based with inline styles and a **light** palette. Email clients strip
 * `<style>` blocks and ignore `prefers-color-scheme`, so the in-app dark card
 * cannot be reproduced; a design that assumed it would be unreadable in most
 * inboxes.
 *
 * `p.artwork` is still deliberately absent. It is a *reference* to library
 * artwork, and resolving it here would mean minting a public URL — permanent
 * unauthenticated access to a library — or reaching into the media-server
 * integration to attach bytes. Neither belongs in a renderer.
 *
 * A digest item's `imageUrl` is a different thing and IS rendered: it is a third
 * party's already public poster (TMDB, TVmaze) for a title nobody owns yet, so
 * there is no authentication to leak and nothing private to expose — and it is
 * the only way a poster reaches an inbox, since a mail client cannot
 * authenticate. It is re-validated here rather than trusted: only `http` and
 * `https` become a `src`, because the value originates from a provider.
 */
/**
 * Only `http`/`https` may become a `src`.
 *
 * The builder checks this too. It is repeated here because this function turns
 * a string into markup that runs in somebody's mail client, and a renderer that
 * trusts its input to have been cleaned elsewhere is one refactor away from not
 * being cleaned at all.
 */
function safeSrc(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/**
 * One title in a digest: poster beside a synopsis and its metadata.
 *
 * Two table cells rather than flexbox — Outlook ignores flex, and a digest that
 * collapsed into a column of orphaned posters there would be worse than no
 * poster at all. The image carries fixed width/height so the layout holds while
 * it loads, and `alt` so a client with images off still reads the title.
 */
function renderItem(item: NonNullable<NotificationPresentation['items']>[number]): string {
  const src = safeSrc(item.imageUrl);
  const poster = src
    ? `<td width="92" valign="top" style="padding:0 14px 0 0;">
         <img src="${esc(src)}" width="92" height="138" alt="${esc(item.title)}"
              style="display:block;width:92px;height:138px;object-fit:cover;border-radius:6px;background:#e2e8f0;border:0;" />
       </td>`
    : '';

  const facts = (item.facts ?? [])
    .map((f) => `<span style="white-space:nowrap;"><span style="color:#94a3b8;">${esc(f.label)}:</span> ${esc(f.value)}</span>`)
    .join('<span style="color:#cbd5e1;"> &middot; </span>');

  return `<tr>
    <td style="padding:16px 0;border-top:1px solid #e2e8f0;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        <tr>
          ${poster}
          <td valign="top">
            <p style="margin:0 0 2px;font-size:15px;font-weight:600;color:#0f172a;">${esc(item.title)}</p>
            ${item.subtitle ? `<p style="margin:0 0 6px;font-size:12px;color:#64748b;">${esc(item.subtitle)}</p>` : ''}
            ${facts ? `<p style="margin:0 0 8px;font-size:12px;color:#475569;line-height:1.6;">${facts}</p>` : ''}
            ${item.synopsis ? `<p style="margin:0;font-size:13px;color:#475569;line-height:1.5;">${esc(item.synopsis)}</p>` : ''}
            ${item.note ? `<p style="margin:8px 0 0;font-size:12px;color:#94a3b8;font-style:italic;">${esc(item.note)}</p>` : ''}
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

export function renderEmailHtml(p: NotificationPresentation): string {
  const accent = ACCENT_HEX[p.accent] ?? ACCENT_HEX.neutral;
  const [before, emphasis, after] = splitSummary(p.summary);
  const items = (p.items ?? []).length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin-top:8px;">
         ${(p.items ?? []).map(renderItem).join('')}
       </table>`
    : '';

  const facts = p.facts
    .map(
      (f) => `<tr>
        <td style="padding:4px 12px 4px 0;color:#64748b;font-size:13px;white-space:nowrap;">${esc(f.label)}</td>
        <td style="padding:4px 0;color:#0f172a;font-size:13px;">${esc(f.value)}</td>
      </tr>`,
    )
    .join('');

  const progress = p.progress
    ? `<div style="margin-top:12px;height:6px;background:#e2e8f0;border-radius:3px;">
         <div style="height:6px;width:${p.progress.percent}%;background:${accent};border-radius:3px;"></div>
       </div>`
    : '';

  const width = items ? 640 : 520;
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:${width}px;border-collapse:collapse;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
  <tr>
    <td style="border-left:4px solid ${accent};border-top:1px solid #e2e8f0;border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;border-radius:8px;padding:20px;background:#ffffff;">
      <p style="margin:0 0 12px;font-size:11px;letter-spacing:1.5px;color:#94a3b8;">ULTRATORRENT</p>
      <h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;color:#0f172a;">
        <span style="color:${accent};">${esc(p.headline.lead)}</span> ${esc(p.headline.trail)}
      </h1>
      <p style="margin:0 0 16px;font-size:14px;color:#475569;">
        ${esc(before)}<strong style="color:#0f172a;">${esc(emphasis)}</strong>${esc(after)}
      </p>
      ${facts ? `<table role="presentation" cellpadding="0" cellspacing="0">${facts}</table>` : ''}
      ${items}
      ${progress}
      ${p.status ? `<p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">${esc(p.status)}</p>` : ''}
    </td>
  </tr>
</table>`;
}

/** Subject line: the headline, so an inbox list reads sensibly. */
export function renderEmailSubject(p: NotificationPresentation): string {
  return `${p.headline.lead} ${p.headline.trail}`.trim().slice(0, 180);
}
