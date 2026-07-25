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
 * Artwork is deliberately absent. The presentation carries an artwork
 * *reference*, not an image, and resolving it here would mean either minting a
 * public URL — permanent unauthenticated access to library artwork — or reaching
 * into the media-server integration to attach bytes. Neither belongs in a
 * renderer, so email carries the full text instead. A real limitation, stated
 * rather than hidden.
 */
export function renderEmailHtml(p: NotificationPresentation): string {
  const accent = ACCENT_HEX[p.accent] ?? ACCENT_HEX.neutral;
  const [before, emphasis, after] = splitSummary(p.summary);

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

  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;border-collapse:collapse;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
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
