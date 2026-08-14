import { buildPushdownWhere } from './condition-pushdown';

/**
 * The property under test is not "does it narrow" but "can it ever narrow away
 * something the evaluator would have matched". Every case below is a way that
 * could happen.
 */
const NOW = new Date('2026-08-14T12:00:00Z');
const DAY = 86_400_000;
const cond = (field: string, operator: string, value: unknown) =>
  ({ type: 'condition', field, operator, value }) as never;
const all = (...children: unknown[]) => ({ type: 'all', children }) as never;
const any = (...children: unknown[]) => ({ type: 'any', children }) as never;

describe('buildPushdownWhere', () => {
  it('pushes a media kind down to the column', () => {
    expect(buildPushdownWhere(all(cond('metadata.mediaKind', 'eq', 'movie')), NOW))
      .toEqual({ AND: [{ mediaType: 'movie' }] });
  });

  it('pushes a library id down — the case that makes a scan selective', () => {
    expect(buildPushdownWhere(all(cond('safety.libraryId', 'eq', 'lib-1')), NOW))
      .toEqual({ AND: [{ libraryId: 'lib-1' }] });
  });

  it('inverts age into a date, older days meaning an earlier timestamp', () => {
    const out = buildPushdownWhere(all(cond('storage.addedAgeDays', 'gt', 30)), NOW) as never as
      { AND: Array<{ createdAt: { lt: Date } }> };
    // Padded to 29 days, not 30: the evaluator floors its day count, so an item
    // on the boundary must still be loaded and judged there.
    expect(out.AND[0].createdAt.lt.getTime()).toBe(NOW.getTime() - 29 * DAY);
  });

  it('pads the other direction for a younger-than filter', () => {
    const out = buildPushdownWhere(all(cond('storage.addedAgeDays', 'lt', 7)), NOW) as never as
      { AND: Array<{ createdAt: { gt: Date } }> };
    expect(out.AND[0].createdAt.gt.getTime()).toBe(NOW.getTime() - 8 * DAY);
  });

  it('combines several conditions instead of merging them onto one key', () => {
    // `year > 2000 AND year < 2020` merged into one object would lose a bound.
    const out = buildPushdownWhere(
      all(cond('metadata.releaseYear', 'gt', 2000), cond('metadata.releaseYear', 'lt', 2020)),
      NOW,
    );
    expect(out).toEqual({ AND: [{ year: { gt: 2000 } }, { year: { lt: 2020 } }] });
  });

  it('IGNORES conditions under an any group', () => {
    /*
     * The dangerous case. Under OR the condition need not hold for the item to
     * match, so narrowing on it would drop items the policy wants.
     */
    expect(buildPushdownWhere(any(cond('metadata.mediaKind', 'eq', 'movie')), NOW)).toEqual({});
    expect(buildPushdownWhere(
      all(cond('safety.libraryId', 'eq', 'lib-1'), any(cond('metadata.mediaKind', 'eq', 'movie'))),
      NOW,
    )).toEqual({ AND: [{ libraryId: 'lib-1' }] });
  });

  it('descends nested all groups, which are still conjunctions', () => {
    expect(buildPushdownWhere(
      all(all(cond('metadata.mediaKind', 'eq', 'movie'))),
      NOW,
    )).toEqual({ AND: [{ mediaType: 'movie' }] });
  });

  it('declines anything it cannot translate exactly', () => {
    for (const node of [
      cond('metadata.mediaKind', 'neq', 'movie'),      // NULL semantics differ
      cond('metadata.mediaKind', 'contains', 'mov'),   // no column semantics
      cond('playback.neverWatched', 'eq', true),       // lives in another table
      cond('technical.videoCodec', 'eq', 'hevc'),      // probe data, not a column here
      cond('metadata.releaseYear', 'eq', 'not-a-year'),
      cond('storage.addedAgeDays', 'eq', 30),          // an exact day is not a range
    ]) {
      expect(buildPushdownWhere(all(node), NOW)).toEqual({});
    }
  });

  it('returns an empty filter for no conditions at all', () => {
    // Which restores exactly the previous behaviour: load everything in scope.
    expect(buildPushdownWhere(undefined, NOW)).toEqual({});
    expect(buildPushdownWhere(all(), NOW)).toEqual({});
  });
});
