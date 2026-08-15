import { isHoldingFile, itemsInPlayback } from './active-playback';

/**
 * Every case here is a way a rename could land on a file someone is watching.
 * The bias throughout is that an uncertain match counts as playing: a skipped
 * rename costs a tidy filename, a wrong one ends someone's episode in an error.
 */
const episode = (id: string, title: string, season: number, ep: number) =>
  ({ id, title, season, episode: ep });
const film = (id: string, title: string, year?: number) => ({ id, title, year });

describe('isHoldingFile', () => {
  it('counts paused as holding the file', () => {
    // A paused stream resumes into the same open path; moving it is worse than
    // moving a playing one, because the viewer is away and comes back to an error.
    expect(isHoldingFile('paused')).toBe(true);
    expect(isHoldingFile('playing')).toBe(true);
    expect(isHoldingFile('buffering')).toBe(true);
  });

  it('counts an explicitly finished session as free', () => {
    expect(isHoldingFile('stopped')).toBe(false);
    expect(isHoldingFile('ended')).toBe(false);
  });

  it('treats an unknown or missing state as holding', () => {
    // Not knowing is not permission.
    expect(isHoldingFile(null)).toBe(true);
    expect(isHoldingFile(undefined)).toBe(true);
    expect(isHoldingFile('')).toBe(true);
    expect(isHoldingFile('weird-new-state')).toBe(true);
  });
});

describe('itemsInPlayback', () => {
  it('matches an episode on series, season and episode', () => {
    const out = itemsInPlayback(
      [episode('a', 'Invincible', 4, 3), episode('b', 'Invincible', 4, 4)],
      [{ title: 'I Gotta Get Some Air', showTitle: 'Invincible', seasonNumber: 4, episodeNumber: 3 }],
    );
    expect([...out]).toEqual(['a']);
  });

  it('does not match a different episode of the same show', () => {
    const out = itemsInPlayback(
      [episode('b', 'Invincible', 4, 4)],
      [{ title: 'x', showTitle: 'Invincible', seasonNumber: 4, episodeNumber: 3 }],
    );
    expect(out.size).toBe(0);
  });

  it('takes the series from the session title when showTitle is absent', () => {
    // Some servers report only `title` for an episode session.
    const out = itemsInPlayback(
      [episode('a', 'Invincible', 4, 3)],
      [{ title: 'Invincible', seasonNumber: 4, episodeNumber: 3 }],
    );
    expect([...out]).toEqual(['a']);
  });

  it('matches a film on title, ignoring punctuation and case', () => {
    const out = itemsInPlayback([film('m', 'WALL·E', 2008)], [{ title: 'Wall-E', year: 2008 }]);
    expect([...out]).toEqual(['m']);
  });

  it('rejects a film whose year genuinely disagrees', () => {
    // Two different films share the name; only one is being watched.
    const out = itemsInPlayback([film('m', 'Dune', 1984)], [{ title: 'Dune', year: 2021 }]);
    expect(out.size).toBe(0);
  });

  it('still matches when only one side knows the year', () => {
    /*
     * A session without a year must not slip past the guard on a technicality —
     * the title alone is enough to stop the rename.
     */
    expect([...itemsInPlayback([film('m', 'Dune', 2021)], [{ title: 'Dune' }])]).toEqual(['m']);
    expect([...itemsInPlayback([film('m', 'Dune')], [{ title: 'Dune', year: 2021 }])]).toEqual(['m']);
  });

  it('ignores sessions that have finished', () => {
    const out = itemsInPlayback(
      [episode('a', 'Invincible', 4, 3)],
      [{ title: 'x', showTitle: 'Invincible', seasonNumber: 4, episodeNumber: 3, playbackState: 'stopped' }],
    );
    expect(out.size).toBe(0);
  });

  it('returns nothing when no one is watching', () => {
    expect(itemsInPlayback([episode('a', 'Invincible', 4, 3)], []).size).toBe(0);
  });

  it('flags every copy of a film that is playing', () => {
    // Two files of one film: the server opened one of them and we cannot tell
    // which, so neither may be moved.
    const out = itemsInPlayback(
      [film('a', 'Moana 2'), film('b', 'Moana 2')],
      [{ title: 'Moana 2' }],
    );
    expect([...out].sort()).toEqual(['a', 'b']);
  });
});
