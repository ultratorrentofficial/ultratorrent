import { describe, expect, it } from 'vitest';
import { TorrentState } from '@ultratorrent/shared';
import { torrentCapabilities } from './torrentCapabilities';

const at = (state: TorrentState) => torrentCapabilities({ state });

describe('torrentCapabilities', () => {
  it('lets a transferring torrent be paused or stopped, not resumed', () => {
    for (const s of [TorrentState.DOWNLOADING, TorrentState.SEEDING, TorrentState.ALLOCATING]) {
      expect(at(s)).toEqual(expect.arrayContaining(['pause', 'stop']));
      // The defect this fixes: Resume was live on a downloading torrent, and
      // the click was a request the engine would reject.
      expect(at(s)).not.toContain('resume');
    }
  });

  it('lets a halted torrent be resumed or started, not paused', () => {
    for (const s of [TorrentState.PAUSED, TorrentState.STOPPED, TorrentState.COMPLETED]) {
      expect(at(s)).toEqual(expect.arrayContaining(['resume', 'start']));
      expect(at(s)).not.toContain('pause');
    }
  });

  it('treats a queued torrent as startable and stoppable, but not pausable', () => {
    /*
     * The case the two prior implementations disagreed on: the drawer bar
     * counted QUEUED as paused (offering Resume), the bulk path as running
     * (offering Pause). A queued torrent is scheduled but not transferring, so
     * it can be started now or taken out of the queue — there is nothing in
     * flight to pause.
     */
    const caps = at(TorrentState.QUEUED);
    expect(caps).toEqual(expect.arrayContaining(['start', 'resume', 'stop']));
    expect(caps).not.toContain('pause');
  });

  it('offers stop for anything not already stopped', () => {
    expect(at(TorrentState.STOPPED)).not.toContain('stop');
    expect(at(TorrentState.DOWNLOADING)).toContain('stop');
    expect(at(TorrentState.PAUSED)).toContain('stop');
  });

  it('treats an errored torrent as halted and still recheckable', () => {
    // A failed hash check is exactly when someone wants to force another.
    expect(at(TorrentState.ERROR)).toEqual(expect.arrayContaining(['resume', 'recheck']));
  });

  it('refuses a recheck while the engine is already checking', () => {
    expect(at(TorrentState.CHECKING)).not.toContain('recheck');
  });

  it('advertises nothing for an unknown state', () => {
    // An engine reporting a state we do not model must withhold actions rather
    // than guess; a wrong guess here stops or deletes someone's transfer.
    expect(at(TorrentState.UNKNOWN)).toEqual([]);
  });

  it('never advertises a token outside the known set', () => {
    const known = new Set(['resume', 'pause', 'start', 'stop', 'recheck']);
    for (const s of Object.values(TorrentState)) {
      for (const token of at(s)) expect(known).toContain(token);
    }
  });

  it('never advertises both pause and resume at once', () => {
    // They are opposites; a state offering both would mean the model is wrong,
    // and the bar would show two contradictory buttons.
    for (const s of Object.values(TorrentState)) {
      const caps = at(s);
      expect(caps.includes('pause') && caps.includes('resume')).toBe(false);
    }
  });
});
