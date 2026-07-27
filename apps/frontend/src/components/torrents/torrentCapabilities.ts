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

/*
 * `QUEUED` is the case the two prior implementations disagreed about:
 * `TorrentActionsBar` counted it among the paused states (offering Resume),
 * while the bulk path treated it as running (offering Pause). Consolidating
 * forced the question, and neither was quite right — a queued torrent is
 * scheduled but not transferring, so it can be *started* now or *stopped* out
 * of the queue, but there is nothing in flight to pause.
 */

/** Actively moving bytes — the only state where pausing means anything. */
const TRANSFERRING = new Set<TorrentState>([
  TorrentState.DOWNLOADING,
  TorrentState.SEEDING,
  TorrentState.ALLOCATING,
]);

/** Not transferring, so it can be started or resumed. */
const HALTED = new Set<TorrentState>([
  TorrentState.PAUSED,
  TorrentState.STOPPED,
  TorrentState.ERROR,
  TorrentState.COMPLETED,
  TorrentState.QUEUED,
]);

export function torrentCapabilities(torrent: TorrentLike): string[] {
  const caps: string[] = [];

  if (TRANSFERRING.has(torrent.state)) {
    caps.push('pause');
  }
  if (HALTED.has(torrent.state)) {
    caps.push('resume', 'start');
  }
  // Stopping applies to anything not already stopped — including a queued
  // torrent, which is how you take it out of the queue.
  if (torrent.state !== TorrentState.STOPPED && torrent.state !== TorrentState.UNKNOWN) {
    caps.push('stop');
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
