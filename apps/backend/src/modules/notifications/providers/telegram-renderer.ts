import { splitSummary, type NotificationPresentation, type PresentationIcon } from '@ultratorrent/shared';

/**
 * Icon names → emoji.
 *
 * Emphasis only: a client that renders none still reads correctly, because the
 * emoji never carries meaning the text does not.
 */
const ICON_EMOJI: Record<PresentationIcon, string> = {
  play: '▶️', stop: '⏹️', pause: '⏸️', buffering: '⏳',
  download: '⬇️', alert: '⚠️', disk: '💾', workflow: '⚙️', plug: '🔌',
  shield: '🔒', user: '👤', film: '🎬', tv: '📺', clock: '🕒', percent: '📊',
  monitor: '🖥️', activity: '📈', library: '📚', server: '🗄️', gauge: '📶',
};

/**
 * Escape the five characters Telegram treats as HTML.
 *
 * A media title is arbitrary user-visible text — a show legitimately called
 * `<Blink>` must render as its own name, and an unescaped one would either break
 * the message or inject markup.
 */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Telegram's hard limit. Exceeding it is a rejected send, not a truncated one. */
const MAX_LENGTH = 4096;

/**
 * Truncate on characters, not code units.
 *
 * Slicing a string by code unit can cut a surrogate pair in half, and a message
 * ending in half an emoji is rejected as invalid UTF-8.
 */
function clamp(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * Render a presentation as Telegram HTML.
 *
 * HTML rather than MarkdownV2: MarkdownV2 requires escaping eighteen characters
 * and rejects the whole message on one miss. With arbitrary media titles that
 * fails often, and a silently undelivered notification is the worst outcome
 * here.
 *
 * Artwork is omitted for the same reason as email — the presentation carries a
 * reference, and resolving it would mean minting a permanent unauthenticated URL
 * or reaching into the media-server integration to upload bytes.
 */
export function renderTelegram(p: NotificationPresentation): string {
  const icon = ICON_EMOJI[p.icon] ?? '';
  const [before, emphasis, after] = splitSummary(p.summary);

  const lines: string[] = [];
  lines.push(`${icon} <b>${esc(p.headline.lead)} ${esc(p.headline.trail)}</b>`.trim());
  lines.push(`${esc(before)}<b>${esc(emphasis)}</b>${esc(after)}`);

  if (p.facts.length) {
    lines.push('');
    for (const fact of p.facts) {
      lines.push(`${ICON_EMOJI[fact.icon] ?? '•'} <i>${esc(fact.label)}:</i> ${esc(fact.value)}`);
    }
  }
  if (p.progress) lines.push('', `📊 ${esc(p.progress.label)}`);

  return clamp(lines.join('\n'), MAX_LENGTH);
}
