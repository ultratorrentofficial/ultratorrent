import { normalizeTitle } from '../cleanup/domain/playback-resolution';

/**
 * Which library items someone is watching right now.
 *
 * Renaming a file that a media server is streaming breaks the stream mid-play:
 * the server holds the path it opened, and moving it out from under a viewer
 * ends their episode with an error. That is the one failure of an organiser that
 * a person actually notices, and it is invisible from this side — the file is
 * readable, the move succeeds, and the damage happens on someone's television.
 *
 * A session identifies what it is playing by TITLE, season and episode; there is
 * no file path in it. So the match is on identity, and every rule below leans the
 * same way: **an uncertain match counts as playing.** Skipping a rename costs a
 * tidier filename until the next run; getting it wrong costs someone's evening.
 */

/** One now-playing session, narrowed to what identification needs. */
export interface PlayingSession {
  title: string;
  showTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  year?: number | null;
  playbackState?: string | null;
}

/** A library item being considered for a move or rename. */
export interface GuardedItem {
  id: string;
  title: string;
  season?: number | null;
  episode?: number | null;
  year?: number | null;
}

/**
 * Is this session holding a file open?
 *
 * **Paused counts.** A paused stream still has the file open and resumes into
 * it, so moving it is exactly as breaking as moving a playing one — arguably
 * worse, since the viewer is away and returns to an error. Only a state that
 * explicitly says the session is over is treated as finished.
 */
export function isHoldingFile(state: string | null | undefined): boolean {
  const s = (state ?? '').trim().toLowerCase();
  return s !== 'stopped' && s !== 'ended';
}

function sameTitle(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  return !!na && na === nb;
}

/**
 * The ids of items currently being played.
 *
 * An episode matches on series title plus season and episode number. A film
 * matches on title, and on year only when BOTH sides carry one — a session that
 * omits the year must not be allowed to slip past a guard on that technicality.
 */
export function itemsInPlayback(
  items: readonly GuardedItem[],
  sessions: readonly PlayingSession[],
): Set<string> {
  const live = sessions.filter((s) => isHoldingFile(s.playbackState));
  const playing = new Set<string>();
  if (!live.length) return playing;

  for (const item of items) {
    for (const session of live) {
      const isEpisode = item.season != null && item.episode != null;

      if (isEpisode) {
        // The series name may arrive as `showTitle` or, on some servers, as the
        // session's own `title`.
        const series = session.showTitle ?? session.title;
        if (
          sameTitle(series, item.title)
          && session.seasonNumber === item.season
          && session.episodeNumber === item.episode
        ) {
          playing.add(item.id);
          break;
        }
        continue;
      }

      if (!sameTitle(session.title, item.title)) continue;
      // Years disagreeing is a genuine mismatch — two films of one name. Either
      // side missing one is not evidence of anything, so the title stands alone.
      if (session.year != null && item.year != null && session.year !== item.year) continue;
      playing.add(item.id);
      break;
    }
  }
  return playing;
}
