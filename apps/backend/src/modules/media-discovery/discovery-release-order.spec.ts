import { earliestRelease, pageByRelease, sortByRelease, type ReleaseOrderable } from './discovery-release-order';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const title = (id: string, name: string, ...dates: Array<[string | null, string | null]>): ReleaseOrderable => ({
  id,
  title: name,
  releaseDates: dates.map(([date, airsAt]) => ({
    date: date ? day(date) : null,
    airsAt: airsAt ? new Date(airsAt) : null,
  })),
});

describe('the release a title is ordered by', () => {
  it('is the earliest dated one', () => {
    expect(
      earliestRelease([
        { date: day('2026-12-20'), airsAt: null },
        { date: day('2026-10-01'), airsAt: null },
      ]),
    ).toBe(day('2026-10-01').getTime());
  });

  /*
   * The same rule the card uses. A 9pm Eastern airing is stamped 01:00 UTC the
   * next day; ordering on the calendar date instead would disagree with the
   * time the card prints.
   */
  it('takes the exact instant over the calendar date when both are present', () => {
    expect(earliestRelease([{ date: day('2026-11-15'), airsAt: new Date('2026-11-16T01:00:00Z') }])).toBe(
      Date.parse('2026-11-16T01:00:00Z'),
    );
  });

  it('is null when nothing is dated', () => {
    expect(earliestRelease([{ date: null, airsAt: null }])).toBeNull();
    expect(earliestRelease([])).toBeNull();
  });
});

describe('ordering titles chronologically', () => {
  it('puts the soonest release first, whatever order the rows arrived in', () => {
    const sorted = sortByRelease([
      title('a', 'Dig', ['2026-11-23', null]),
      title('b', 'Neagley', ['2026-09-16', null]),
      title('c', 'Carrie', ['2026-10-07', null]),
    ]);
    expect(sorted.map((r) => r.title)).toEqual(['Neagley', 'Carrie', 'Dig']);
  });

  /*
   * An unannounced date is not "soonest". Sorting null as zero would put every
   * undated title at the top of a list meant to answer "what arrives next".
   */
  it('puts titles with no dated release last', () => {
    const sorted = sortByRelease([
      title('a', 'Undated'),
      title('b', 'Later', ['2026-12-01', null]),
      title('c', 'Also undated', [null, null]),
    ]);
    expect(sorted.map((r) => r.title)).toEqual(['Later', 'Also undated', 'Undated']);
  });

  it('breaks a same-day tie by title', () => {
    const sorted = sortByRelease([
      title('a', 'Youth', ['2026-09-20', null]),
      title('b', 'American Hostage', ['2026-09-20', null]),
    ]);
    expect(sorted.map((r) => r.title)).toEqual(['American Hostage', 'Youth']);
  });

  /*
   * Pages are slices of this order. If two identical keys could swap between
   * requests, one title would appear on two pages and another on none.
   */
  it('is stable across calls even when release and title are identical', () => {
    const rows = [title('zz', 'Same', ['2026-09-20', null]), title('aa', 'Same', ['2026-09-20', null])];
    expect(sortByRelease(rows).map((r) => r.id)).toEqual(['aa', 'zz']);
    expect(sortByRelease([...rows].reverse()).map((r) => r.id)).toEqual(['aa', 'zz']);
  });

  it('does not mutate the rows it was given', () => {
    const rows = [title('a', 'Later', ['2026-12-01', null]), title('b', 'Sooner', ['2026-09-01', null])];
    sortByRelease(rows);
    expect(rows.map((r) => r.title)).toEqual(['Later', 'Sooner']);
  });
});

describe('a page in release order', () => {
  const catalogue = [
    title('dig', 'Dig', ['2026-11-23', null]),
    title('neagley', 'Neagley', ['2026-09-16', null]),
    title('carrie', 'Carrie', ['2026-10-07', null]),
    title('war', 'War', ['2026-10-01', null]),
    title('undated', 'Untitled Project'),
  ];

  /*
   * The database returns `id IN (…)` in its own order — here, deliberately the
   * reverse. A page built by trusting it would be sorted server-side and then
   * shuffled on the way out.
   */
  const loadRows = async (ids: string[]) => [...ids].reverse().map((id) => ({ id }));

  it('returns the page in release order even when the rows come back shuffled', async () => {
    const page = await pageByRelease(async () => catalogue, loadRows, { skip: 0, take: 3 });
    expect(page.rows.map((r) => r.id)).toEqual(['neagley', 'war', 'carrie']);
    expect(page.total).toBe(5);
  });

  it('continues on the next page where the last one stopped', async () => {
    const page = await pageByRelease(async () => catalogue, loadRows, { skip: 3, take: 3 });
    expect(page.rows.map((r) => r.id)).toEqual(['dig', 'undated']);
  });

  it('loads nothing in full for a page past the end', async () => {
    const loads: string[][] = [];
    const page = await pageByRelease(
      async () => catalogue,
      async (ids) => {
        loads.push(ids);
        return [];
      },
      { skip: 50, take: 24 },
    );
    expect(page).toEqual({ rows: [], total: 5 });
    expect(loads).toEqual([]);
  });

  /*
   * A title removed between the two reads comes back from the second one
   * missing, and an unexpected extra must not be slipped onto the page.
   */
  it('tolerates a title that disappears between the two reads', async () => {
    const page = await pageByRelease(
      async () => catalogue,
      async (ids) => [...ids.filter((id) => id !== 'war').map((id) => ({ id })), { id: 'stranger' }],
      { skip: 0, take: 3 },
    );
    expect(page.rows.map((r) => r.id)).toEqual(['neagley', 'carrie']);
  });
});
