import { type NotificationPresentation, type PresentationAccent } from '@ultratorrent/shared';
import { stripMentions } from '../channels/discord-validators';

/**
 * Accent → embed stripe colour, as an integer.
 *
 * The stripe is the only colour Discord gives an embed, and it is what carries
 * started-versus-stopped at a glance — the reason to send an embed at all rather
 * than a content string.
 */
const ACCENT_COLORS: Record<PresentationAccent, number> = {
  started: 0x22c55e,
  stopped: 0xf43f5e,
  success: 0x22c55e,
  warning: 0xf59e0b,
  error: 0xdc2626,
  neutral: 0x64748b,
};

/** Discord's documented limits. Exceeding one rejects the whole message. */
const LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  fields: 25,
  footer: 2048,
} as const;

/**
 * Truncate on characters, not code units — slicing a surrogate pair in half
 * produces invalid UTF-8 and a rejected payload.
 */
function clamp(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * Neutralise Markdown so a media title cannot inject formatting.
 *
 * A film legitimately called `**Batman**` must render as its own name. More
 * importantly, an unescaped `[text](url)` is how a message smuggles in a masked
 * link that looks like it came from UltraTorrent.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/([*_`~|\\[\]()>#-])/g, '\\$1');
}

/** Both escapes, in the order that matters: strip mentions, then escape markup. */
function safe(text: string): string {
  return escapeMarkdown(stripMentions(text));
}

/**
 * Render a presentation as a Discord webhook payload.
 *
 * An embed rather than plain content, because the coloured stripe is the only
 * way Discord conveys tone, and tone is half of what a playback card says.
 *
 * **`allowed_mentions: { parse: [] }` is on every payload.** It tells Discord to
 * resolve no mentions at all — the authoritative protection against a media
 * title containing `@everyone` paging an entire server. The text-level stripping
 * in `safe()` is belt and braces.
 *
 * Artwork is omitted. Discord renders images only from a URL it can fetch
 * anonymously, and minting one would create permanent unauthenticated access to
 * library artwork that outlives the notification — so the embed carries the full
 * text instead. A real limitation, stated rather than hidden.
 */
export function renderDiscord(p: NotificationPresentation): Record<string, unknown> {
  return {
    // Discord resolves nothing: no @everyone, no @here, no roles, no users.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: clamp(safe(`${p.headline.lead} ${p.headline.trail}`.trim()), LIMITS.title),
        description: clamp(safe(p.summary.text), LIMITS.description),
        color: ACCENT_COLORS[p.accent] ?? ACCENT_COLORS.neutral,
        fields: p.facts.slice(0, LIMITS.fields).map((f) => ({
          name: clamp(safe(f.label), LIMITS.fieldName),
          value: clamp(safe(f.value), LIMITS.fieldValue),
          inline: true,
        })),
        footer: { text: clamp('UltraTorrent', LIMITS.footer) },
        timestamp: p.timestamp,
      },
    ],
  };
}
