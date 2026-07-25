import type {
  NotificationPresentation,
  PresentationAccent,
  PresentationIcon,
} from '@ultratorrent/shared';

/**
 * Channel projections of a `NotificationPresentation`.
 *
 * Every function here is pure and takes the same input, which is the point: the
 * card an email shows and the one Discord shows are the same *content* differently
 * expressed, not two independently maintained templates.
 *
 * ## Why no artwork on external channels
 *
 * None of these can display the poster. Discord renders images only from a URL it
 * can fetch anonymously, and minting one would create permanent unauthenticated
 * access to library artwork that outlives the notification — the confirmed
 * decision is to omit the thumbnail rather than publish it. The same reasoning
 * applies to Telegram and email here: neither has a token-free URL available, and
 * uploading bytes would require this layer to reach into the media-server
 * integration to fetch them. Artwork therefore stays an in-app affordance, and
 * external channels carry the full text instead. This is a real limitation, not
 * an oversight.
 */

/** Discord embed stripe colours — the accent tokens, as integers. */
const ACCENT_COLORS: Record<PresentationAccent, number> = {
  positive: 0x22c55e,
  negative: 0xef4444,
  warning: 0xf59e0b,
  critical: 0xe11d48,
  neutral: 0x64748b,
};

/**
 * Icon names → emoji, for channels that cannot draw a component.
 *
 * A channel with no emoji support degrades to the text alone, which still reads
 * correctly — the emoji is emphasis, never the only carrier of meaning.
 */
const ICON_EMOJI: Record<PresentationIcon, string> = {
  play: '▶️',
  stop: '⏹️',
  pause: '⏸️',
  user: '👤',
  film: '🎬',
  tv: '📺',
  clock: '🕒',
  percent: '📊',
  monitor: '🖥️',
  activity: '📈',
  library: '📚',
  server: '🗄️',
  alert: '⚠️',
};

/** Provider hard limits. Exceeding them is a rejected send, not a truncated one. */
const LIMITS = {
  telegram: 4096,
  discordContent: 2000,
  discordFieldValue: 1024,
  discordTitle: 256,
} as const;

/**
 * Truncate on a character basis with an ellipsis.
 *
 * `Array.from` again: slicing a string by code unit can cut a surrogate pair in
 * half, and a title ending in half an emoji is how a send gets rejected for
 * invalid UTF-8.
 */
function clamp(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** Escape the five characters that would otherwise be markup in Telegram HTML mode. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Neutralize Markdown so a media title cannot inject formatting.
 *
 * A film legitimately called `**Batman**` must render as its own name, not as
 * bold "Batman" — and on Discord an unescaped title is also how a message
 * smuggles in a masked link.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/([*_`~|\\[\]()>#-])/g, '\\$1');
}

/** The meta line under the summary: "8:24 PM · Now playing". */
function metaLine(p: NotificationPresentation): string {
  const time = p.facts.find((f) => f.icon === 'clock')?.value ?? '';
  return [time, p.status].filter(Boolean).join(' · ');
}

/**
 * Plain text — the universal fallback, and what an email's text part carries.
 * Every other renderer is an enrichment of this, so a channel that loses its
 * formatting still delivers the same facts in the same order.
 */
export function presentationToText(p: NotificationPresentation): string {
  const lines = [p.summary.text];
  const meta = metaLine(p);
  if (meta) lines.push(meta);
  if (p.facts.length) {
    lines.push('');
    for (const fact of p.facts) lines.push(`${fact.label}: ${fact.value}`);
  }
  return lines.join('\n');
}

/**
 * Telegram, in HTML parse mode.
 *
 * HTML rather than MarkdownV2 because MarkdownV2 requires escaping eighteen
 * characters and rejects the whole message on one miss — a media title is
 * arbitrary user-visible text, so the stricter mode fails far more often.
 */
export function presentationToTelegram(p: NotificationPresentation): { text: string; parseMode: 'HTML' } {
  const icon = ICON_EMOJI[p.icon] ?? '';
  const [before, emphasis, after] = splitFor(p);
  const summary = `${escapeHtml(before)}<b>${escapeHtml(emphasis)}</b>${escapeHtml(after)}`;

  const parts = [`${icon} ${summary}`.trim()];
  const meta = metaLine(p);
  if (meta) parts.push(`<i>${escapeHtml(meta)}</i>`);

  return { text: clamp(parts.join('\n'), LIMITS.telegram), parseMode: 'HTML' };
}

/**
 * Discord, as an embed.
 *
 * An embed rather than a content string because it is the only Discord surface
 * with a colour — which is what carries started-versus-stopped at a glance, the
 * whole point of the accent. Fields reproduce the fact table; the progress bar
 * has no equivalent and folds into its fact.
 */
export function presentationToDiscord(p: NotificationPresentation): Record<string, unknown> {
  return {
    embeds: [
      {
        title: clamp(`${ICON_EMOJI[p.icon] ?? ''} ${p.headline.lead} ${p.headline.trail}`.trim(), LIMITS.discordTitle),
        description: clamp(escapeMarkdown(p.summary.text), LIMITS.discordContent),
        color: ACCENT_COLORS[p.accent] ?? ACCENT_COLORS.neutral,
        // Discord caps embeds at 25 fields; the card has at most four, but the
        // slice keeps a future builder from producing a rejected payload.
        fields: p.facts.slice(0, 25).map((f) => ({
          name: clamp(f.label, LIMITS.discordTitle),
          value: clamp(escapeMarkdown(f.value), LIMITS.discordFieldValue),
          inline: true,
        })),
        footer: { text: p.eyebrow },
        timestamp: p.timestamp,
      },
    ],
  };
}

/**
 * Email HTML.
 *
 * Table-based with inline styles, and a dark-on-light palette: email clients
 * strip `<style>` blocks and ignore `prefers-color-scheme`, so the in-app dark
 * card cannot be reproduced and a design that assumed it would be unreadable in
 * most inboxes.
 */
export function presentationToEmailHtml(p: NotificationPresentation): string {
  const stripe = `#${(ACCENT_COLORS[p.accent] ?? ACCENT_COLORS.neutral).toString(16).padStart(6, '0')}`;
  const [before, emphasis, after] = splitFor(p);
  const meta = metaLine(p);

  const facts = p.facts
    .map(
      (f) => `<tr>
        <td style="padding:4px 12px 4px 0;color:#64748b;font-size:13px;white-space:nowrap;">${escapeHtml(f.label)}</td>
        <td style="padding:4px 0;color:#0f172a;font-size:13px;">${escapeHtml(f.value)}</td>
      </tr>`,
    )
    .join('');

  const progress = p.progress
    ? `<div style="margin-top:12px;height:6px;background:#e2e8f0;border-radius:3px;">
         <div style="height:6px;width:${p.progress.percent}%;background:${stripe};border-radius:3px;"></div>
       </div>`
    : '';

  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;border-collapse:collapse;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
  <tr>
    <td style="border-left:4px solid ${stripe};border-top:1px solid #e2e8f0;border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;border-radius:8px;padding:20px;background:#ffffff;">
      <p style="margin:0 0 12px;font-size:11px;letter-spacing:1.5px;color:#94a3b8;">${escapeHtml(p.eyebrow)}</p>
      <h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;color:#0f172a;">
        <span style="color:${stripe};">${escapeHtml(p.headline.lead)}</span> ${escapeHtml(p.headline.trail)}
      </h1>
      <p style="margin:0 0 16px;font-size:14px;color:#475569;">
        ${escapeHtml(before)}<strong style="color:#0f172a;">${escapeHtml(emphasis)}</strong>${escapeHtml(after)}
      </p>
      ${facts ? `<table role="presentation" cellpadding="0" cellspacing="0">${facts}</table>` : ''}
      ${progress}
      ${meta ? `<p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">${escapeHtml(meta)}</p>` : ''}
    </td>
  </tr>
</table>`;
}

/**
 * Local copy of the shared `splitSummary`, returning empty strings rather than
 * throwing on a mismatch — see that function for why a not-found emphasis must
 * degrade to unemphasized text instead of dropping the sentence.
 */
function splitFor(p: NotificationPresentation): [string, string, string] {
  const { text, emphasis } = p.summary;
  if (!emphasis) return [text, '', ''];
  const at = text.lastIndexOf(emphasis);
  if (at < 0) return [text, '', ''];
  return [text.slice(0, at), emphasis, text.slice(at + emphasis.length)];
}
