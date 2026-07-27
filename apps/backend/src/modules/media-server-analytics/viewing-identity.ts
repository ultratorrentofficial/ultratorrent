/**
 * What is being watched, as distinct from where it is being watched.
 *
 * A media server's session id identifies a CLIENT PLAYBACK SESSION, not a
 * viewing. Plex's Windows client autoplays the next episode inside the same
 * session: measured live on synoplex, one row (`lib5u42oofqu59730m2ng1t7`,
 * `dennis.ayala`, Windows) carried a Criminal Minds binge from 02:16 to 04:54
 * and eight episodes without ever being recreated. Everything keyed on "a
 * session row appeared" therefore fired once for the whole evening — one
 * notification, one watch-history row titled after the LAST episode, and one
 * Trakt scrobble.
 *
 * So identity is the item, and these helpers are what the poller compares.
 */

export interface ViewingIdentity {
  title?: string | null;
  showTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  year?: number | null;
}

/**
 * A stable key for the thing being played.
 *
 * Episodes key on show + season + number rather than on the episode's name: two
 * shows can have an episode called "Pilot", and a provider that renames an
 * episode mid-playback must not read as a different one. Everything else keys on
 * title + year, which is what tells the two `Aladdin`s apart.
 */
export function viewingKey(v: ViewingIdentity): string {
  if (v.showTitle && v.seasonNumber != null && v.episodeNumber != null) {
    return `ep:${v.showTitle.trim().toLowerCase()}:s${v.seasonNumber}:e${v.episodeNumber}`;
  }
  return `t:${(v.title ?? '').trim().toLowerCase()}:${v.year ?? ''}`;
}

/**
 * True when the session has moved on to a different item — the transition that
 * ends one viewing and begins another.
 *
 * The display title has to differ TOO, and that second condition is the guard
 * against a false ending: a provider that momentarily reports an episode without
 * its show or season would otherwise flip the key from `ep:…` to `t:…` and fake a
 * stop-and-start in the middle of an episode. Two consecutive items that share a
 * display title are not a case that occurs — the title carries the episode name.
 */
export function isNewViewing(prev: ViewingIdentity, next: ViewingIdentity): boolean {
  return viewingKey(prev) !== viewingKey(next) && (prev.title ?? null) !== (next.title ?? null);
}
