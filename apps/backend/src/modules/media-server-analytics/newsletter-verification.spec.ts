import {
  DEFERRAL_WINDOW_MS, isPublishable, nextDeferred, parseDeferred, partitionDeferred, verifyEntry,
  type WithheldEntry,
} from './newsletter-verification';

const COMPLETE = {
  title: 'Rose of Nevada',
  year: 2026,
  overview: 'A fishing town, and a boat that came back.',
  rating: 6.9,
  runtime: 114,
  genres: ['Drama'],
};

describe('what a newsletter entry must have to be published', () => {
  it('publishes an entry with artwork and a synopsis', () => {
    const v = verifyEntry(COMPLETE, true);
    expect(v.missing).toEqual([]);
    expect(isPublishable(v)).toBe(true);
  });

  it('withholds an entry with no artwork — the card would be an initial in a box', () => {
    const v = verifyEntry(COMPLETE, false);
    expect(v.missing).toEqual(['art']);
    expect(isPublishable(v)).toBe(false);
  });

  it('withholds an entry with no synopsis', () => {
    const v = verifyEntry({ ...COMPLETE, overview: null }, true);
    expect(v.missing).toEqual(['overview']);
  });

  /*
   * The six films that went out bare on 2026-09-04 all looked like this: a
   * metadata row existed, so nothing upstream reported a problem, and every
   * field in it was null.
   */
  it('withholds an entry that has a metadata row but nothing in it', () => {
    const v = verifyEntry(
      { title: 'Leviticus', year: 2026, overview: null, rating: null, runtime: null, genres: [] },
      false,
    );
    expect(v.missing).toEqual(['art', 'overview']);
    expect(isPublishable(v)).toBe(false);
  });

  it('treats whitespace as no synopsis at all', () => {
    expect(verifyEntry({ ...COMPLETE, overview: '   \n ' }, true).missing).toEqual(['overview']);
  });

  it('reports a missing runtime or rating without withholding — the pill just does not render', () => {
    const v = verifyEntry({ ...COMPLETE, runtime: null, rating: 0 }, true);
    expect(v.missing).toEqual([]);
    expect(isPublishable(v)).toBe(true);
    expect(v.advisory).toEqual(['runtime', 'rating']);
  });

  it('counts a zero runtime as absent, not as a value', () => {
    expect(verifyEntry({ ...COMPLETE, runtime: 0 }, true).advisory).toContain('runtime');
  });
});

describe('carrying a withheld item to the next issue', () => {
  const now = new Date('2026-09-04T16:00:00Z');
  const iso = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('ignores stored entries that are not shaped like deferrals', () => {
    expect(parseDeferred(null)).toEqual([]);
    expect(parseDeferred('nope')).toEqual([]);
    expect(parseDeferred([{ id: '' }, 42, { firstDeferredAt: iso(0) }])).toEqual([]);
  });

  it('keeps a stored entry whose timestamp is unreadable, dated so it expires', () => {
    const [d] = parseDeferred([{ id: 'i1', firstDeferredAt: 'not a date' }]);
    expect(d.id).toBe('i1');
    expect(Date.parse(d.firstDeferredAt)).toBe(0);
  });

  it('retries an item inside the window and gives up past it', () => {
    const { live, expired } = partitionDeferred(
      [
        { id: 'fresh', firstDeferredAt: iso(7 * 24 * 3600 * 1000) },
        { id: 'stale', firstDeferredAt: iso(DEFERRAL_WINDOW_MS + 1000) },
      ],
      now,
    );
    expect(live.map((d) => d.id)).toEqual(['fresh']);
    expect(expired.map((d) => d.id)).toEqual(['stale']);
  });

  /*
   * The window measures the whole wait. Restamping every issue would reset it
   * weekly and nothing would ever expire, which is the bug this test exists for.
   */
  it('keeps the date an item was FIRST held back', () => {
    const first = iso(14 * 24 * 3600 * 1000);
    const withheld: WithheldEntry[] = [
      { itemId: 'i1', title: 'Middletown', year: 2025, mediaType: 'movie', missing: ['art'] },
      { itemId: 'i2', title: 'Leviticus', year: 2026, mediaType: 'movie', missing: ['art'] },
    ];
    const out = nextDeferred(withheld, [{ id: 'i1', firstDeferredAt: first }], now);
    expect(out).toEqual([
      { id: 'i1', firstDeferredAt: first },
      { id: 'i2', firstDeferredAt: now.toISOString() },
    ]);
  });

  it('cannot carry forward an entry with no item behind it', () => {
    const out = nextDeferred(
      [{ title: 'A show with no representative episode', year: null, mediaType: 'show', missing: ['art'] }],
      [],
      now,
    );
    expect(out).toEqual([]);
  });
});
