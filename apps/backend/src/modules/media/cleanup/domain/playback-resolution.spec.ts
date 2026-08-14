import {
  buildTitleIndex, isMovieRow, normalizeTitle, resolvePlaybackRows,
} from './playback-resolution';

/**
 * Attribution is the dangerous half of playback aggregation: a wrong match marks
 * the wrong film watched, and leaves the one actually watched looking untouched
 * and therefore deletable.
 */
const items = [
  { id: 'meg2', title: 'Meg 2: The Trench', year: 2023 },
  { id: 'meg', title: 'The Meg', year: 2018 },
  { id: 'motu', title: 'Masters of the Universe' },
  { id: 'wall', title: 'WALL·E', year: 2008 },
  { id: 'dupeA', title: 'Moana 2' },
  { id: 'dupeB', title: 'Moana 2' },
];
const index = buildTitleIndex(items);
const play = (title: string, mediaType = 'movie') => ({ title, mediaType });

describe('normalizeTitle', () => {
  it('folds case, punctuation and diacritics', () => {
    expect(normalizeTitle('WALL·E')).toBe(normalizeTitle('Wall-E'));
    expect(normalizeTitle('Amélie')).toBe('amelie');
    expect(normalizeTitle("Ocean's Eleven")).toBe('oceans eleven');
  });

  it('unifies & with and, and drops a leading article', () => {
    expect(normalizeTitle('Fire & Ice')).toBe(normalizeTitle('Fire and Ice'));
    expect(normalizeTitle('The Meg')).toBe('meg');
  });

  it('keeps a year that distinguishes a remake from its original', () => {
    // Stripping these would merge two different films into one aggregate.
    expect(normalizeTitle('Dune (1984)')).not.toBe(normalizeTitle('Dune (2021)'));
  });
});

describe('isMovieRow', () => {
  it('accepts the media-server spellings of a film', () => {
    for (const t of ['movie', 'Movies', 'FILM']) expect(isMovieRow(t)).toBe(true);
  });

  it('rejects episodes and anything unlabelled', () => {
    for (const t of ['episode', 'show', 'track', '', null, undefined]) {
      expect(isMovieRow(t)).toBe(false);
    }
  });
});

describe('resolvePlaybackRows', () => {
  it('attributes a play to the film it names', () => {
    const out = resolvePlaybackRows([play('Meg 2: The Trench')], index);
    expect([...out.byItem.keys()]).toEqual(['meg2']);
    expect(out.unresolved).toBe(0);
  });

  it('does not confuse a sequel with its original', () => {
    // "The Meg" and "Meg 2: The Trench" normalize apart; a looser match that
    // merged them would mark the unwatched one watched.
    const out = resolvePlaybackRows([play('The Meg')], index);
    expect([...out.byItem.keys()]).toEqual(['meg']);
  });

  it('gives the play to EVERY copy of a duplicated film', () => {
    /*
     * Two files of one film are two items. Attributing the play to only one
     * would leave the other looking never watched — and it is the one a purge
     * policy would then take.
     */
    const out = resolvePlaybackRows([play('Moana 2')], index);
    expect([...out.byItem.keys()].sort()).toEqual(['dupeA', 'dupeB']);
  });

  it('counts a film the library does not hold as unresolved', () => {
    const out = resolvePlaybackRows([play('Some Film Not In The Library')], index);
    expect(out.byItem.size).toBe(0);
    expect(out.unresolved).toBe(1);
  });

  it('reports an episode of an unheld series as unresolved, not as a film', () => {
    // This index holds films only, so the series cannot be found — that is an
    // unresolved row, not a match against some similarly-named film.
    const out = resolvePlaybackRows([play('FROM — A Rock and a Farway', 'episode')], index);
    expect(out.byItem.size).toBe(0);
    expect(out.unresolved).toBe(1);
  });

  it('skips media that is neither film nor episode', () => {
    const out = resolvePlaybackRows([play('Some Song', 'track')], index);
    expect(out.byItem.size).toBe(0);
    expect(out.skippedNonMovie).toBe(1);
    expect(out.unresolved).toBe(0);
  });

  it('accumulates repeat plays of the same film', () => {
    const out = resolvePlaybackRows(
      [play('Meg 2: The Trench'), play('meg 2  the trench'), play('The Meg')],
      index,
    );
    expect(out.byItem.get('meg2')).toHaveLength(2);
    expect(out.byItem.get('meg')).toHaveLength(1);
  });

  it('ignores an empty title rather than matching everything', () => {
    const out = resolvePlaybackRows([play('')], index);
    expect(out.byItem.size).toBe(0);
    expect(out.unresolved).toBe(1);
  });
});

/**
 * Series attribution. An episode row names the episode, the library stores the
 * show — so a play resolves to the SERIES, and its count is the total across all
 * episodes, credited to each of them.
 */
const episodes = [
  { id: 'from-s1e1', title: 'FROM' },
  { id: 'from-s1e2', title: 'FROM' },
  { id: 'ranch-s1e1', title: 'The Secret of Skinwalker Ranch' },
  { id: '24-s1e1', title: '24' },
  { id: '24l-s1e1', title: '24 Legacy' },
];
const showIndex = buildTitleIndex([], episodes);
const ep = (title: string) => ({ title, mediaType: 'episode' });

describe('episode rows resolve to their series', () => {
  it('credits every episode of the show', () => {
    const out = resolvePlaybackRows([ep('FROM — A Rock and a Farway')], showIndex);
    expect([...out.byItem.keys()].sort()).toEqual(['from-s1e1', 'from-s1e2']);
    expect(out.unresolved).toBe(0);
  });

  it('handles a hyphen separator as well as an em dash', () => {
    const out = resolvePlaybackRows([ep('The Secret of Skinwalker Ranch - Breaking Ground')], showIndex);
    expect([...out.byItem.keys()]).toEqual(['ranch-s1e1']);
  });

  it('takes the LONGEST matching series, not the first', () => {
    // `24` prefixes `24 Legacy`; matching short would credit the wrong series.
    const out = resolvePlaybackRows([ep('24 Legacy — Whatever')], showIndex);
    expect([...out.byItem.keys()]).toEqual(['24l-s1e1']);
  });

  it('still matches the short series when that is the one played', () => {
    const out = resolvePlaybackRows([ep('24 — Day 1: 12:00 A.M.')], showIndex);
    expect([...out.byItem.keys()]).toEqual(['24-s1e1']);
  });

  it('sums the whole series onto each episode', () => {
    /*
     * The requested semantics: a show's watch count is the total across its
     * episodes. Three plays of different episodes make three plays on each item,
     * so a series being watched can never leave any of its episodes looking
     * never-watched.
     */
    const out = resolvePlaybackRows(
      [ep('FROM — One'), ep('FROM — Two'), ep('FROM — Three')],
      showIndex,
    );
    expect(out.byItem.get('from-s1e1')).toHaveLength(3);
    expect(out.byItem.get('from-s1e2')).toHaveLength(3);
  });

  it('reports an unknown series as unresolved rather than guessing', () => {
    const out = resolvePlaybackRows([ep('Some Show We Do Not Hold — Pilot')], showIndex);
    expect(out.byItem.size).toBe(0);
    expect(out.unresolved).toBe(1);
  });
});
