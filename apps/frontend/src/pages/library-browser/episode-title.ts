/**
 * The name of an episode, from wherever it actually lives.
 *
 * Three sources, and the obvious one is usually wrong:
 *
 * - `MediaItem.title` is the **show's** title. For an episodic file the scanner
 *   takes it from the show folder, because a filename often carries only the
 *   episode name and grouping every episode under one series matters more.
 * - `MediaMetadata.title` is *also* the show's title on real libraries —
 *   enrichment resolves the series, not the episode. Measured on a live
 *   library: all eight episodes of *A Gentleman in Moscow* carried
 *   "A Gentleman in Moscow" here.
 * - The **filename** is where the episode name really is, because that is what
 *   the renamer writes: `Show - S01E03 - Long, Long Time.mkv`.
 *
 * So the filename is preferred, and metadata is used only when it says
 * something the show title does not — which is what makes this correct both for
 * renamed libraries and for ones enriched at episode level.
 */

/** `Show - S01E03 - Episode Name.mkv` → `Episode Name`. */
export function titleFromFilename(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = path.split('/').pop() ?? '';
  const withoutExt = base.replace(/\.[a-z0-9]{2,4}$/i, '');

  // Everything after the episode marker and its separator. Anchored on SxxExx
  // rather than on " - " so a show whose NAME contains a dash cannot be split
  // in the wrong place.
  const m = /\bs\d{1,2}[\s._-]*e\d{1,3}(?:[\s._-]*e\d{1,3})?\b[\s._-]+(.+)$/i.exec(withoutExt);
  if (!m) return null;

  const raw = m[1].replace(/[._]+/g, ' ').trim();
  if (!raw) return null;

  /*
   * A scene release continues with quality tokens rather than a title
   * (`…S01E05.1080p.HEVC.x265-MeGusta`). Taking that as the episode name would
   * put "1080p HEVC x265-MeGusta" in the list, which is worse than showing
   * nothing.
   */
  if (/^(\d{3,4}p|\d{3,4}i|web[\s-]?dl|webrip|bluray|hdtv|x26[45]|h\.?26[45]|hevc|avc|dvdrip|remux|repack|proper)\b/i.test(raw)) {
    return null;
  }
  return raw;
}

/**
 * Pick the episode name to display, or null when nothing knows it.
 *
 * `showTitle` is what the row would otherwise repeat; metadata equal to it is
 * treated as "no episode name" rather than as an answer.
 */
export function episodeTitleOf(input: {
  path?: string | null;
  metadataTitle?: string | null;
  showTitle?: string | null;
}): string | null {
  const fromFile = titleFromFilename(input.path);
  if (fromFile) return fromFile;

  const meta = input.metadataTitle?.trim();
  if (meta && meta.toLowerCase() !== (input.showTitle ?? '').trim().toLowerCase()) return meta;

  return null;
}
