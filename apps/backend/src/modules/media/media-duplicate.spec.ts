import { duplicateKeys, detectDuplicateGroups, type DuplicateItemLike } from './media-duplicate.service';

function ep(id: string, title: string, season: number, episode: number, over: Partial<DuplicateItemLike> = {}): DuplicateItemLike {
  return { id, mediaType: 'tv', title, year: null, season, episode, externalIds: [], files: [], ...over };
}

describe('duplicateKeys — episode discrimination', () => {
  it('gives different episodes of the same show entirely different keys', () => {
    const e1 = duplicateKeys(ep('1', 'House of the Dragon', 1, 1)).map((k) => k.key);
    const e2 = duplicateKeys(ep('2', 'House of the Dragon', 1, 2)).map((k) => k.key);
    expect(e1.some((k) => e2.includes(k))).toBe(false);
  });

  it('does NOT collide episodes that share a series-level external id (the TVDB bug)', () => {
    // Both episodes carry the same series-level TVDB id — must not group.
    const seriesId = [{ provider: 'tvdb', externalId: '7960887' }];
    const e1 = duplicateKeys(ep('1', '13 Reasons Why', 1, 1, { externalIds: seriesId })).map((k) => k.key);
    const e3 = duplicateKeys(ep('3', '13 Reasons Why', 1, 3, { externalIds: seriesId })).map((k) => k.key);
    expect(e1.some((k) => e3.includes(k))).toBe(false);
  });

  it('still groups two files of the SAME episode', () => {
    const a = ep('a', 'The Wire', 2, 4, { externalIds: [{ provider: 'tvdb', externalId: '999' }] });
    const b = ep('b', 'The Wire', 2, 4, { externalIds: [{ provider: 'tvdb', externalId: '999' }] });
    const groups = detectDuplicateGroups([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0].itemIds.sort()).toEqual(['a', 'b']);
  });

  it('does not group a whole series as duplicates', () => {
    const episodes = Array.from({ length: 6 }, (_, i) =>
      ep(String(i), 'Silverpeak', 1, i + 1, { externalIds: [{ provider: 'tvdb', externalId: '555' }] }),
    );
    expect(detectDuplicateGroups(episodes)).toHaveLength(0);
  });

  it('separates UNIDENTIFIED episodes (null season/episode) by the SxxEyy in the title', () => {
    // Real case: Chicago P.D. episodes with null season/episode columns but the
    // marker in the title, all sharing a series-level external id.
    const seriesId = [{ provider: 'imdb', externalId: 'tt2686424' }];
    const raw = (id: string, s: string): DuplicateItemLike =>
      ({ id, mediaType: 'tv', title: `Chicago P.D. - ${s} - Ep`, year: null, season: null, episode: null, externalIds: seriesId, files: [] });
    const groups = detectDuplicateGroups([raw('1', 'S01E01'), raw('2', 'S01E02'), raw('3', 'S13E21')]);
    expect(groups).toHaveLength(0);
  });

  it('does NOT group different shows that share one (corrupt) external id', () => {
    // Real case: many shows' S01E01 all carried the SAME external id.
    const sharedId = [{ provider: 'imdb', externalId: 'tt0000000' }];
    const s = (id: string, show: string, season: number) => ep(id, show, season, 1, { externalIds: sharedId });
    const groups = detectDuplicateGroups([s('1', 'Dickinson', 1), s('2', 'Hawkeye', 1), s('3', 'Extrapolations', 1)]);
    expect(groups).toHaveLength(0);
  });

  it('does NOT group different shows sharing one id even when unidentified', () => {
    const sharedId = [{ provider: 'imdb', externalId: 'tt0000000' }];
    const raw = (id: string, show: string): DuplicateItemLike =>
      ({ id, mediaType: 'tv', title: `${show} - S01E01 - Pilot`, year: null, season: null, episode: null, externalIds: sharedId, files: [] });
    expect(detectDuplicateGroups([raw('1', 'Dickinson'), raw('2', 'Hawkeye')])).toHaveLength(0);
  });

  it('still groups two files of the same unidentified episode', () => {
    const seriesId = [{ provider: 'imdb', externalId: 'tt2686424' }];
    const raw = (id: string): DuplicateItemLike =>
      ({ id, mediaType: 'tv', title: 'Chicago P.D. - S01E01 - Stepping Stone', year: null, season: null, episode: null, externalIds: seriesId, files: [] });
    const groups = detectDuplicateGroups([raw('a'), raw('b')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].itemIds.sort()).toEqual(['a', 'b']);
  });
});

describe('duplicateKeys — movies still work', () => {
  const movie = (id: string, title: string, year: number | null): DuplicateItemLike => ({ id, mediaType: 'movie', title, year, season: null, episode: null, externalIds: [], files: [] });

  it('groups the same movie by title + year', () => {
    const groups = detectDuplicateGroups([movie('m1', 'The Long Night', 2024), movie('m2', 'The Long Night', 2024)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].itemIds.sort()).toEqual(['m1', 'm2']);
  });

  it('does NOT group different films that share a title (Aladdin 1992 vs 2019)', () => {
    const a1 = duplicateKeys(movie('a', 'Aladdin', 2019)).map((k) => k.key);
    const a2 = duplicateKeys(movie('b', 'Aladdin', 1992)).map((k) => k.key);
    expect(a1.some((k) => a2.includes(k))).toBe(false);
    expect(detectDuplicateGroups([movie('a', 'Aladdin', 2019), movie('b', 'Aladdin', 1992)])).toHaveLength(0);
  });
});

describe('detectDuplicateGroups — group identity is stable across scans', () => {
  // Detection used to delete every group and recreate it, so a group's id changed on
  // every run. That is why no ignore could persist: "this is not a duplicate" had
  // nothing durable to attach to. The bucket key is now carried out of grouping and
  // used as the group's stable identity, so the same real-world group survives a
  // rescan and a human decision stays attached to it.
  const movie = (id: string, title: string, year: number): DuplicateItemLike => ({
    id, mediaType: 'movie', title, year, season: null, episode: null, externalIds: [], files: [],
  });

  it('produces the same key for the same real-world group on a second run', () => {
    const first = detectDuplicateGroups([movie('a', 'Hotel Mumbai', 2019), movie('b', 'Hotel Mumbai', 2019)]);
    // Same media, different row ids — a rescan re-reads the library.
    const second = detectDuplicateGroups([movie('c', 'Hotel Mumbai', 2019), movie('d', 'Hotel Mumbai', 2019)]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].key).toBe(second[0].key);
    expect(first[0].key).toContain('hotel mumbai');
  });

  it('gives genuinely different groups different keys', () => {
    const groups = detectDuplicateGroups([
      movie('a', 'Hotel Mumbai', 2019), movie('b', 'Hotel Mumbai', 2019),
      movie('c', 'Aladdin', 1992), movie('d', 'Aladdin', 1992),
    ]);
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.key)).size).toBe(2);
  });

  it('does not let a different year reuse another film\'s key', () => {
    const groups = detectDuplicateGroups([
      movie('a', 'Aladdin', 1992), movie('b', 'Aladdin', 1992),
      movie('c', 'Aladdin', 2019), movie('d', 'Aladdin', 2019),
    ]);
    expect(groups).toHaveLength(2);
    const keys = groups.map((g) => g.key);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('orders deterministically, so two runs over the same library agree', () => {
    const items = [
      movie('a', 'Zulu', 1964), movie('b', 'Zulu', 1964),
      movie('c', 'Alien', 1979), movie('d', 'Alien', 1979),
    ];
    const a = detectDuplicateGroups(items).map((g) => g.key);
    const b = detectDuplicateGroups([...items].reverse()).map((g) => g.key);
    expect(a).toEqual(b);
  });
});
