/**
 * The canonical, channel-neutral notification presentation model.
 *
 * One event produces one `NotificationPresentation`; every surface — the in-app
 * card, email, Telegram, Discord — is a *projection* of it. The alternative,
 * which this replaces, is each channel reaching into the raw event payload and
 * formatting for itself: four implementations of "what does an episode look
 * like", drifting apart the moment one is edited.
 *
 * Three rules hold the model together:
 *
 * 1. **It is data, not markup.** No HTML, no colour codes, no channel syntax.
 *    `accent: 'negative'` is a meaning; whether that becomes `#ef4444`, a red
 *    Discord embed stripe or the word "Stopped" is the renderer's business.
 * 2. **It is already redacted.** The builder decides per recipient what may
 *    appear, so a renderer cannot leak a field by rendering too much. Anything
 *    absent here was withheld deliberately.
 * 3. **Artwork is a reference, never a URL.** A signed or public image link
 *    would outlive the notification and hand out unauthenticated access to
 *    library artwork. Renderers resolve references through authenticated paths
 *    they already own.
 *
 * Lives in `shared` because the frontend renders the same object the backend
 * builds — one type, checked at both ends.
 */

/** Schema version, so a stored presentation can be migrated rather than guessed at. */
export const NOTIFICATION_PRESENTATION_VERSION = 1;

/**
 * Semantic tone. Chosen over naming colours because the same tone maps to a
 * green ring in-app, a `0x22c55e` embed stripe on Discord, and nothing at all in
 * plain text.
 */
export type PresentationAccent =
  | 'positive'
  | 'negative'
  | 'neutral'
  | 'warning'
  | 'critical';

/**
 * Icon *names*, not glyphs. The in-app card maps these to lucide components and
 * external channels to emoji; sending a glyph would force both to accept
 * whatever the builder happened to pick.
 */
export type PresentationIcon =
  | 'play'
  | 'stop'
  | 'pause'
  | 'user'
  | 'film'
  | 'tv'
  | 'clock'
  | 'percent'
  | 'monitor'
  | 'activity'
  | 'library'
  | 'server'
  | 'alert';

/** One label/value row in the card's fact list. */
export interface PresentationFact {
  icon: PresentationIcon;
  /** Already localized. */
  label: string;
  /** Already localized and already redacted. */
  value: string;
}

/**
 * A pointer to artwork the recipient is allowed to see — deliberately not a URL.
 *
 * `kind` says which authenticated route resolves it:
 * - `notification` → the artwork stored against this notification, proxied
 *   through the provider's credentials. Used after a session ends, when the
 *   live session row no longer exists.
 * - `session` → a live session's now-playing art.
 *
 * Media Manager posters are deliberately absent: that endpoint returns a JSON
 * artwork *list*, not an image, so a `media` variant would be a kind no renderer
 * could resolve. Add it when there is a route that serves the bytes.
 */
export interface PresentationArtwork {
  kind: 'notification' | 'session';
  /** Id for the route named by `kind`. Never a path, never a provider URL. */
  id: string;
  aspect: 'poster' | 'thumb';
  /** Alt text, already localized. */
  alt: string;
}

/**
 * An avatar the frontend draws, rather than an image anyone must host.
 *
 * Deliberately initials + hue: no avatar field exists in the schema, and
 * generating and storing images to represent people is a whole feature
 * (upload, validation, moderation, deletion) that a notification card does not
 * justify. External channels that cannot draw a div simply omit it.
 */
export interface PresentationAvatar {
  /** 1–2 characters, already derived; renderers must not re-derive. */
  initials: string;
  /** 0–359, stable per name so the same person keeps the same colour. */
  hue: number;
  /** Accessible name — the display name this was built from. */
  label: string;
}

/** Playback progress. `percent` is 0–100; `label` is localized ("42% watched"). */
export interface PresentationProgress {
  percent: number;
  label: string;
}

/**
 * The single primary action. One, not many: a notification that offers three
 * choices is a page, and every extra button is another surface to authorize.
 */
export interface PresentationAction {
  /** Already localized. */
  label: string;
  /** In-app route (`/media-server/live`), resolved against the base URL for external channels. */
  href: string;
  icon?: PresentationIcon;
}

/**
 * A two-tone headline: `lead` carries the accent colour, `trail` stays neutral.
 * Split at build time because the split is language-dependent — Spanish breaks
 * "Usuario comenzó" / "a ver" in a different place than English does.
 */
export interface PresentationHeadline {
  lead: string;
  trail: string;
}

/**
 * A one-line summary with one emphasized span — "Dennis started watching
 * **Dune (2021)**". Structured rather than pre-marked-up so each channel applies
 * its own emphasis: `<strong>`, `*bold*`, `**bold**`, or none.
 */
export interface PresentationSummary {
  text: string;
  /** The substring of `text` to emphasize. Renderers must verify it occurs. */
  emphasis?: string | null;
}

export interface NotificationPresentation {
  version: typeof NOTIFICATION_PRESENTATION_VERSION;
  /** The event this was built from, for debugging and renderer specialisation. */
  eventKey: string;
  accent: PresentationAccent;
  icon: PresentationIcon;
  /** Small caps brand line. */
  eyebrow: string;
  headline: PresentationHeadline;
  summary: PresentationSummary;
  avatar?: PresentationAvatar | null;
  artwork?: PresentationArtwork | null;
  facts: PresentationFact[];
  progress?: PresentationProgress | null;
  /** Short state chip — "Now playing", "Paused". */
  status?: string | null;
  action?: PresentationAction | null;
  /** ISO 8601. Rendered relative in-app ("2m ago"), absolute elsewhere. */
  timestamp: string;
}

/* ------------------------------------------------------------------ helpers */

/**
 * Initials from a display name: "Dennis Ayala" → "DA", "dennis" → "D".
 *
 * Uses `Array.from` rather than `split('')` so a name starting with an emoji or
 * an astral-plane character yields that character instead of half a surrogate
 * pair.
 */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = Array.from(words[0])[0] ?? '?';
  if (words.length === 1) return first.toUpperCase();
  const second = Array.from(words[words.length - 1])[0] ?? '';
  return (first + second).toUpperCase();
}

/**
 * A stable hue for a name, so one person keeps one colour across every card.
 *
 * FNV-1a — not for security, only for spread: a plain character sum gives
 * anagrams the same colour and clusters short names at the low end.
 */
export function hueFor(name: string): number {
  let h = 0x811c9dc5;
  for (const ch of name) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 360;
}

/** Build an avatar from a display name, or nothing if there is no name to show. */
export function avatarFor(name: string | null | undefined): PresentationAvatar | null {
  const label = (name ?? '').trim();
  if (!label) return null;
  return { initials: initialsFor(label), hue: hueFor(label), label };
}

/**
 * `S01E03` — zero-padded to two digits, which is what every media naming
 * convention uses and what makes episodes sort correctly as text.
 */
export function formatEpisodeCode(season: number, episode: number): string {
  const pad = (n: number) => String(Math.max(0, Math.trunc(n))).padStart(2, '0');
  return `S${pad(season)}E${pad(episode)}`;
}

/**
 * The display title for whatever is playing.
 *
 * - episode with numbering → `The Last of Us - S01E03`
 * - movie with a year     → `Dune (2021)`
 * - anything else         → the title as given
 *
 * Falls through deliberately: a provider that reports a show title but no
 * numbering still gets the show name rather than an empty parenthetical.
 */
export function formatMediaLabel(input: {
  title: string;
  showTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  year?: number | null;
}): string {
  const { title, showTitle, seasonNumber, episodeNumber, year } = input;
  if (showTitle && seasonNumber != null && episodeNumber != null) {
    return `${showTitle} - ${formatEpisodeCode(seasonNumber, episodeNumber)}`;
  }
  if (showTitle) return showTitle;
  if (year) return `${title} (${year})`;
  return title;
}

/**
 * Resolve `summary.emphasis` into `[before, emphasis, after]` for renderers.
 *
 * Returns the whole string as `before` when the emphasis is absent or not found,
 * so a renderer never has to handle a mismatch — and a bad build degrades to
 * unemphasized text rather than dropping the sentence.
 */
export function splitSummary(summary: PresentationSummary): [string, string, string] {
  const { text, emphasis } = summary;
  if (!emphasis) return [text, '', ''];
  const at = text.lastIndexOf(emphasis);
  if (at < 0) return [text, '', ''];
  return [text.slice(0, at), emphasis, text.slice(at + emphasis.length)];
}

/**
 * Type guard for a stored presentation.
 *
 * `UserNotification.payload` is free-form JSON that predates this model, so most
 * rows have no presentation at all and old rows may have an earlier version.
 * Renderers call this and fall back to the plain title/body rather than throwing
 * inside a notification list.
 */
export function isNotificationPresentation(value: unknown): value is NotificationPresentation {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<NotificationPresentation>;
  return (
    p.version === NOTIFICATION_PRESENTATION_VERSION &&
    typeof p.eventKey === 'string' &&
    typeof p.eyebrow === 'string' &&
    !!p.headline && typeof p.headline.lead === 'string' &&
    !!p.summary && typeof p.summary.text === 'string' &&
    Array.isArray(p.facts)
  );
}
