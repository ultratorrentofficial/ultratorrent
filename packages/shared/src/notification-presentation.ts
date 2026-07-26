/**
 * The canonical presentation model.
 *
 * One event produces one presentation; the in-app card, the bell preview and
 * (from Phase 4) email, Telegram and Discord are all *projections* of it. The
 * Live Activity dashboard renders the same playback shape, so a session card and
 * a playback notification cannot drift apart — they are the same data.
 *
 * Three rules keep it honest:
 *
 * 1. **Data, not markup.** No HTML, no JSX, no Telegram syntax, no Discord embed
 *    JSON. `accent: 'stopped'` is a meaning; what colour that becomes belongs to
 *    the renderer.
 * 2. **Already redacted.** The server decides per recipient what a presentation
 *    contains. A field that is absent was withheld deliberately, so a renderer
 *    cannot leak by rendering too much.
 * 3. **Artwork is a reference, never a URL.** A link that resolved without a
 *    token would be permanent unauthenticated access to library artwork,
 *    outliving the notification that carried it.
 */

export const PRESENTATION_VERSION = 2;

/**
 * Semantic tone. `stopped` is deliberately distinct from `error`: playback
 * ending is red in the concept, but it is not a failure, and a renderer that
 * conflated them would put an error icon on a normal event.
 */
export type PresentationAccent =
  | 'started'
  | 'stopped'
  | 'success'
  | 'warning'
  | 'error'
  | 'neutral';

/** Icon *names*. Renderers map these to components or emoji; never a glyph here. */
export type PresentationIcon =
  | 'play' | 'stop' | 'pause' | 'buffering'
  | 'download' | 'alert' | 'disk' | 'workflow' | 'plug'
  | 'shield' | 'user' | 'film' | 'tv' | 'clock' | 'percent'
  | 'monitor' | 'activity' | 'library' | 'server' | 'gauge';

/** One label/value row. Both sides already localized and already redacted. */
export interface PresentationFact {
  icon: PresentationIcon;
  label: string;
  value: string;
}

/**
 * A pointer to artwork the recipient may see — deliberately not a URL.
 *
 * `kind` names the authenticated route that resolves it:
 * - `session` — a live session's now-playing art.
 * - `notification` — art recorded against a stored notification, for when the
 *   session row is gone (it is deleted the instant playback ends).
 * - `media` — a Media Manager item's poster.
 */
export interface PresentationArtwork {
  kind: 'session' | 'notification' | 'media';
  id: string;
  aspect: 'poster' | 'thumb';
  /** Localized alt text. */
  alt: string;
  /** Media type, so a placeholder can be tinted sensibly when resolution fails. */
  mediaType?: string | null;
}

/**
 * An avatar the client draws rather than an image anyone hosts.
 *
 * Initials plus a stable hue: no avatar field exists in the schema, and storing
 * generated images to represent people is an upload/validation/moderation
 * feature a notification card does not justify.
 */
export interface PresentationAvatar {
  /** 1–2 characters, already derived. Renderers must not re-derive. */
  initials: string;
  /** 0–359, stable per name so one person keeps one colour everywhere. */
  hue: number;
  /** Accessible name — the display name this came from. */
  label: string;
}

/** Playback progress. `percent` is 0–100; `label` is localized. */
export interface PresentationProgress {
  percent: number;
  label: string;
  /** "01:12:30 / 02:14:00" when known. */
  positionLabel?: string | null;
}

/** The single primary action. One, not many — more choices make it a page. */
export interface PresentationAction {
  label: string;
  /** Internal route. Built server-side from a fixed map, never from a payload. */
  href: string;
  icon?: PresentationIcon;
}

/**
 * A two-tone headline: `lead` carries the accent, `trail` stays neutral.
 * Split server-side because the split point is language-dependent.
 */
export interface PresentationHeadline {
  lead: string;
  trail: string;
}

/**
 * A one-line summary with one emphasized span. Structured rather than
 * pre-marked-up so each surface applies its own emphasis.
 */
export interface PresentationSummary {
  text: string;
  emphasis?: string | null;
}

/**
 * What is playing, split into the two lines every surface wants.
 *
 * `formatMediaLabel` joins these into one string for a compact row; a poster-led
 * layout needs them apart, because "The Last of Us" is the title and
 * "S01E03 • Long Long Time" is subordinate to it. Splitting a joined label back
 * apart is guesswork, so the split is made once, here, and carried.
 *
 * Channel-neutral on purpose: this is not a Telegram field. The in-app card and
 * Live Activity read the same two lines, which is what stops them drifting.
 */
export interface PresentationMedia {
  kind: 'movie' | 'episode' | 'music' | 'audiobook' | 'other';
  /** The thing's own name — a film, a series, a track, a book. */
  primary: string;
  /** Subordinate detail: episode code + title, artist, author. Null when none. */
  secondary: string | null;
}

export interface NotificationPresentation {
  version: typeof PRESENTATION_VERSION;
  eventKey: string;
  accent: PresentationAccent;
  icon: PresentationIcon;
  headline: PresentationHeadline;
  summary: PresentationSummary;
  avatar?: PresentationAvatar | null;
  artwork?: PresentationArtwork | null;
  /**
   * Structured media identity, when the event is about something playing.
   *
   * Optional rather than required, and the version stays at 2: presentations are
   * STORED, so historical rows predate this field. A renderer must fall back to
   * `summary` when it is absent rather than assume every row has it.
   */
  media?: PresentationMedia | null;
  /**
   * One short line of context — "4K HDR • Living Room Apple TV".
   *
   * At most two compact facts, already localized and already redacted. It exists
   * because `facts` is a table: correct for a card with room, wrong for a phone
   * notification, where a labelled list reads as a monitoring alert. A surface
   * picks one or the other; both come from the same builder.
   */
  context?: string | null;
  facts: PresentationFact[];
  progress?: PresentationProgress | null;
  /** Short state chip — "Now playing", "Paused". */
  status?: string | null;
  action?: PresentationAction | null;
  /** ISO 8601. Rendered relative in-app, absolute elsewhere. */
  timestamp: string;
}

/* ------------------------------------------------------------------ helpers */

/**
 * Initials from a display name.
 *
 * `Array.from` rather than `split('')`, so a name starting with an emoji or an
 * astral-plane character yields that character instead of half a surrogate pair.
 */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = Array.from(words[0])[0] ?? '?';
  if (words.length === 1) return first.toUpperCase();
  const last = Array.from(words[words.length - 1])[0] ?? '';
  return (first + last).toUpperCase();
}

/**
 * A stable hue for a name.
 *
 * FNV-1a — not for security, only for spread: a character sum gives anagrams the
 * same colour and clusters short names at one end of the wheel.
 */
export function hueFor(name: string): number {
  let h = 0x811c9dc5;
  for (const ch of name) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 360;
}

export function avatarFor(name: string | null | undefined): PresentationAvatar | null {
  const label = (name ?? '').trim();
  if (!label) return null;
  return { initials: initialsFor(label), hue: hueFor(label), label };
}

/** `S01E03` — zero-padded, which is what sorts correctly as text. */
export function formatEpisodeCode(season: number, episode: number): string {
  const pad = (n: number) => String(Math.max(0, Math.trunc(n))).padStart(2, '0');
  return `S${pad(season)}E${pad(episode)}`;
}

/**
 * Split what is playing into its two display lines.
 *
 * The counterpart to `formatMediaLabel`, which joins the same facts into one
 * string. Both live here so Telegram, the in-app card and Live Activity cannot
 * drift — a renderer that formatted titles itself would be the drift.
 *
 * Music and audiobooks need no new producer fields: media servers report the
 * artist/author in the same slot they use for a show title (Plex's
 * `grandparentTitle`), so the existing `showTitle` carries it.
 */
export function formatMediaParts(input: {
  title: string;
  showTitle?: string | null;
  episodeTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  year?: number | null;
  mediaType?: string | null;
}): PresentationMedia {
  const { title, showTitle, episodeTitle, seasonNumber, episodeNumber, year } = input;
  const type = (input.mediaType ?? '').toLowerCase();

  if (type === 'track' || type === 'audio' || type === 'music') {
    return { kind: 'music', primary: title, secondary: showTitle?.trim() || null };
  }
  if (type === 'audiobook' || type === 'book') {
    return { kind: 'audiobook', primary: title, secondary: showTitle?.trim() || null };
  }

  if (showTitle && seasonNumber != null && episodeNumber != null) {
    const code = formatEpisodeCode(seasonNumber, episodeNumber);
    // The episode's own name is genuinely optional — a provider may not report
    // it, and "S01E03" alone is still a complete answer.
    const name = episodeTitle?.trim();
    return { kind: 'episode', primary: showTitle, secondary: name ? `${code} • ${name}` : code };
  }
  if (showTitle) return { kind: 'episode', primary: showTitle, secondary: null };

  if (year) return { kind: 'movie', primary: `${title} (${year})`, secondary: null };
  return { kind: 'other', primary: title, secondary: null };
}

/**
 * The display title for whatever is playing.
 *
 * Falls through deliberately: a provider reporting a show title but no numbering
 * still gets the show name rather than an invented `S00E00`.
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

/** `01:12:30`, or `12:30` under an hour. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.trunc(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * Split a summary into `[before, emphasis, after]`.
 *
 * Returns the whole string as `before` when the emphasis is missing or not
 * found, so a renderer never handles a mismatch and a bad build degrades to
 * unemphasized text rather than a dropped sentence.
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
 * Rows predate this model and older ones may carry an earlier version, so
 * renderers validate and fall back to the plain title rather than throwing
 * inside a list.
 */
export function isNotificationPresentation(value: unknown): value is NotificationPresentation {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<NotificationPresentation>;
  return (
    p.version === PRESENTATION_VERSION &&
    typeof p.eventKey === 'string' &&
    !!p.headline && typeof p.headline.lead === 'string' &&
    !!p.summary && typeof p.summary.text === 'string' &&
    Array.isArray(p.facts)
  );
}
