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

/** Telegram's hard limits. Exceeding either is a rejected send, not a trimmed one. */
const MAX_MESSAGE = 4096;
/** A photo caption is far shorter than a message — 1024, not 4096. */
export const MAX_CAPTION = 1024;

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
 * A rendered Telegram post: what to say, and the one thing to offer.
 *
 * `caption` is used verbatim whether it rides on a photo or a plain message, so
 * a failed image upload degrades to the same words rather than a different
 * message the recipient has to reconcile with the one they usually get.
 */
export interface TelegramRender {
  caption: string;
  /** Null when no externally reachable app URL is configured — see `buildButton`. */
  button: { text: string; url: string } | null;
}

/**
 * Playback, as a person reads it.
 *
 * Three short lines under a poster:
 *
 *     Dennis started watching
 *     Dune: Part Two (2024)
 *     4K HDR • Living Room Apple TV
 *
 * The artwork is the hero, so the words stay out of its way. What this replaces
 * was a stacked list of `Label: value` rows plus a timestamp Telegram already
 * shows beside every message — a monitoring alert, not a notification about a
 * film someone just put on.
 *
 * Everything here comes from the canonical presentation: `media` for the title
 * lines, `context` for the one quality/device line, `summary` for the natural
 * phrase. Nothing is re-derived, so Telegram cannot drift from the in-app card.
 */
function renderPlayback(p: NotificationPresentation): string {
  const lines: string[] = [];

  // "Dennis started watching" — the clause without the media, which follows on
  // its own line. splitSummary returns the whole string as `before` when the
  // emphasis is missing, so a presentation without one still reads correctly.
  const [before, , after] = splitSummary(p.summary);
  const phrase = (before || p.summary.text).trim() || after.trim();
  if (phrase) lines.push(`<b>${esc(phrase)}</b>`);

  if (p.media) {
    lines.push(`<b>${esc(p.media.primary)}</b>`);
    if (p.media.secondary) lines.push(esc(p.media.secondary));
  } else if (p.summary.emphasis) {
    // Pre-`media` stored rows, and any event whose builder does not set it.
    lines.push(`<b>${esc(p.summary.emphasis)}</b>`);
  }

  if (p.context) {
    lines.push('');
    lines.push(esc(p.context));
  }

  return lines.join('\n');
}

/**
 * Everything that is not playback, in the compact style.
 *
 * Still shorter than the original — headline, summary, and at most the facts
 * that carry information a reader cannot infer. A storage warning genuinely
 * wants its numbers; it does not want them as a labelled table.
 */
function renderGeneric(p: NotificationPresentation): string {
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

  return lines.join('\n');
}

/** Events rendered in the compact, artwork-led style. */
function isPlayback(eventKey: string): boolean {
  return eventKey.startsWith('media_server.user_');
}

/**
 * Build the one inline button.
 *
 * Telegram needs an **absolute** URL — it will not accept `/media-server-analytics`
 * — so this returns null when no externally reachable base URL is configured.
 * A button is omitted rather than pointed at a guess: a link to `localhost`
 * from someone's phone is worse than no link, because it looks like a bug in
 * the notification rather than a missing setting.
 *
 * The href is a literal from the builder or the fixed deep-link map, never read
 * from an event payload, and the destination re-authorizes on arrival.
 */
export function buildButton(
  p: NotificationPresentation,
  appUrl: string | null,
): { text: string; url: string } | null {
  if (!p.action || !appUrl) return null;

  const base = appUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;

  const href = p.action.href.startsWith('/') ? p.action.href : `/${p.action.href}`;
  let url: URL;
  try {
    url = new URL(`${base}${href}`);
  } catch {
    return null;
  }
  // Telegram rejects anything that is not http(s), and a configured base that
  // somehow resolved to another scheme must not become a button.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  return { text: clamp(p.action.label, 64), url: url.toString() };
}

/**
 * Render a presentation for Telegram.
 *
 * `withPhoto` selects the caption limit: a photo caption is capped at 1024 and a
 * plain message at 4096, and a caption that fits one does not necessarily fit
 * the other. Rendering the same words for both means the text-only fallback is
 * recognisably the same notification.
 */
export function renderTelegramPost(
  p: NotificationPresentation,
  opts: { appUrl?: string | null; withPhoto?: boolean } = {},
): TelegramRender {
  const body = isPlayback(p.eventKey) ? renderPlayback(p) : renderGeneric(p);
  const limit = opts.withPhoto ? MAX_CAPTION : MAX_MESSAGE;
  return {
    caption: clamp(body, limit),
    button: buildButton(p, opts.appUrl ?? null),
  };
}

/**
 * Text-only rendering.
 *
 * Retained because the linking greeting and the channel test both send plain
 * messages, and because a photo upload that fails falls back to exactly this.
 */
export function renderTelegram(p: NotificationPresentation): string {
  return renderTelegramPost(p).caption;
}
