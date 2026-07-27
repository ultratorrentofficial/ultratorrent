/**
 * What a torrent can have done to it right now, from its state.
 *
 * The two torrent bars offered a fixed list regardless of state: Resume was
 * live on a downloading torrent, Pause on a stopped one, and every such click
 * was a request the engine would reject. They gated on permission — which Jobs
 * did not — so this migration is about *state*, not authorisation.
 *
 * Tokens are named for the action rather than the state, so a surface never has
 * to reason about the state machine a second time.
 */
import { TorrentState } from '@ultratorrent/shared';

export interface TorrentLike {
  state: TorrentState;
}

/** States where the torrent is actively working and can be paused or stopped. */
const RUNNING = new Set<TorrentState>([
  TorrentState.DOWNLOADING,
  TorrentState.SEEDING,
  TorrentState.QUEUED,
  TorrentState.ALLOCATING,
]);

/** States where it is halted and can be resumed or started. */
const HALTED = new Set<TorrentState>([
  TorrentState.PAUSED,
  TorrentState.STOPPED,
  TorrentState.ERROR,
  TorrentState.COMPLETED,
]);

export function torrentCapabilities(torrent: TorrentLike): string[] {
  const caps: string[] = [];

  if (RUNNING.has(torrent.state)) {
    caps.push('pause', 'stop');
  }
  if (HALTED.has(torrent.state)) {
    caps.push('resume', 'start');
  }

  /*
   * Rechecking re-reads every piece from disk. It is refused while the engine is
   * already checking — and deliberately allowed in ERROR, since a failed hash
   * check is exactly when someone wants to force another.
   */
  if (torrent.state !== TorrentState.CHECKING && torrent.state !== TorrentState.UNKNOWN) {
    caps.push('recheck');
  }

  return caps;
}
