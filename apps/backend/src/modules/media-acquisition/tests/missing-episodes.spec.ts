import { MissingEpisodesService } from '../missing-episodes.service';

/**
 * Focused in-memory Prisma stub for the missing-episodes diff. Implements only
 * the delegate surface the service touches (findMany/findUnique/update/create-
 * Many/deleteMany/groupBy) with enough `where` operators (`in`, `not`, insensitive
 * `equals`) to exercise the ownership + classification logic.
 */
function matches(where: any, row: any): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries<any>(where)) {
    if (cond === undefined) continue;
    if (cond === null) {
      if (row[k] !== null && row[k] !== undefined) return false;
      continue;
    }
    if (typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) {
        if (!cond.in.includes(row[k])) return false;
        continue;
      }
      if ('not' in cond) {
        if (cond.not === null) {
          if (row[k] === null || row[k] === undefined) return false;
        } else if (row[k] === cond.not) return false;
        continue;
      }
      if ('equals' in cond) {
        const a = cond.mode === 'insensitive' ? String(row[k] ?? '').toLowerCase() : row[k];
        const b = cond.mode === 'insensitive' ? String(cond.equals).toLowerCase() : cond.equals;
        if (a !== b) return false;
        continue;
      }
      continue; // unknown object operator → treat as match
    }
    if (row[k] !== cond) return false;
  }
  return true;
}

function sortRows(rows: any[], orderBy: any): any[] {
  if (!orderBy) return rows;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      const [field, dir] = Object.entries(spec)[0] as [string, string];
      const av = a[field] ?? -Infinity;
      const bv = b[field] ?? -Infinity;
      if (av < bv) return dir === 'desc' ? 1 : -1;
      if (av > bv) return dir === 'desc' ? -1 : 1;
    }
    return 0;
  });
}

class Table {
  rows: any[] = [];
  private seq = 0;
  constructor(private name: string) {}
  seed(rows: any[]) { this.rows.push(...rows); return this; }

  async findMany({ where, orderBy }: any = {}) {
    return sortRows(this.rows.filter((r) => matches(where, r)), orderBy);
  }
  async findUnique({ where }: any) {
    if (where.id) return this.rows.find((r) => r.id === where.id) ?? null;
    return this.rows.find((r) => matches(where, r)) ?? null;
  }
  async update({ where, data }: any) {
    const row = this.rows.find((r) => r.id === where.id);
    Object.assign(row, data);
    return row;
  }
  async createMany({ data }: any) {
    for (const d of data) this.rows.push({ id: `${this.name}-${++this.seq}`, createdAt: new Date(), lastCheckedAt: new Date(), ...d });
    return { count: data.length };
  }
  async deleteMany({ where }: any = {}) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(where, r));
    return { count: before - this.rows.length };
  }
  async groupBy({ by, where, _count, _max }: any) {
    const rows = this.rows.filter((r) => matches(where, r));
    const groups = new Map<string, any[]>();
    for (const r of rows) {
      const key = JSON.stringify(by.map((k: string) => r[k]));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    return [...groups.entries()].map(([key, gr]) => {
      const vals = JSON.parse(key);
      const out: any = {};
      by.forEach((k: string, i: number) => (out[k] = vals[i]));
      if (_count?._all) out._count = { _all: gr.length };
      if (_max) {
        out._max = {};
        for (const f of Object.keys(_max)) {
          out._max[f] = gr.reduce((m: any, r: any) => (m == null || r[f] > m ? r[f] : m), null);
        }
      }
      return out;
    });
  }
}

const FUTURE = new Date().getFullYear() + 5;

function makePrisma() {
  return {
    mediaAcquisitionWatchlistItem: new Table('wl').seed([
      { id: 'wl1', type: 'series', status: 'active', title: 'The Wire', normalizedTitle: 'the wire', externalIds: { imdb: 'ttSERIES' }, seasonNumber: null, priority: 100 },
      { id: 'wl2', type: 'series', status: 'active', title: 'No Imdb Show', normalizedTitle: 'no imdb show', externalIds: {}, seasonNumber: null, priority: 100 },
    ]),
    iMDbEpisode: new Table('ep').seed([
      { episodeTitleId: 'ttS0E1', parentTitleId: 'ttSERIES', seasonNumber: 0, episodeNumber: 1 }, // special
      { episodeTitleId: 'ttS1E1', parentTitleId: 'ttSERIES', seasonNumber: 1, episodeNumber: 1 },
      { episodeTitleId: 'ttS1E2', parentTitleId: 'ttSERIES', seasonNumber: 1, episodeNumber: 2 },
      { episodeTitleId: 'ttS1E3', parentTitleId: 'ttSERIES', seasonNumber: 1, episodeNumber: 3 },
      { episodeTitleId: 'ttS2E1', parentTitleId: 'ttSERIES', seasonNumber: 2, episodeNumber: 1 }, // future
    ]),
    iMDbTitle: new Table('title').seed([
      { tconst: 'ttS0E1', primaryTitle: 'Special', startYear: 2002 },
      { tconst: 'ttS1E1', primaryTitle: 'The Target', startYear: 2002 },
      { tconst: 'ttS1E2', primaryTitle: 'The Detail', startYear: 2002 },
      { tconst: 'ttS1E3', primaryTitle: 'The Buys', startYear: 2002 },
      { tconst: 'ttS2E1', primaryTitle: 'Ebb Tide', startYear: FUTURE },
    ]),
    mediaItem: new Table('item'),
    wantedEpisode: new Table('wanted'),
  } as any;
}

function makeService(prisma: any) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const realtime = { broadcast: jest.fn() };
  return new MissingEpisodesService(prisma, audit as any, realtime as any);
}

describe('MissingEpisodesService', () => {
  it('classifies owned / missing / unaired and excludes specials', async () => {
    const prisma = makePrisma();
    // Library owns S1E2 via the structured seriesImdbId link.
    prisma.mediaItem.seed([{ id: 'i1', seriesImdbId: 'ttSERIES', mediaType: 'tv', title: 'The Wire', season: 1, episode: 2 }]);
    const svc = makeService(prisma);

    const gap = await svc.scanSeries('wl1', 'u1');

    expect(gap).toMatchObject({ total: 4, owned: 1, missing: 2, unaired: 1, ignored: 0 });
    const rows = await svc.listForSeries('wl1');
    // No season-0 special persisted.
    expect(rows.some((r) => r.seasonNumber === 0)).toBe(false);
    const byKey = (s: number, e: number) => rows.find((r) => r.seasonNumber === s && r.episodeNumber === e)!;
    expect(byKey(1, 1).status).toBe('missing');
    expect(byKey(1, 2).status).toBe('owned');
    expect(byKey(1, 3).status).toBe('missing');
    expect(byKey(2, 1).status).toBe('unaired'); // future air year
  });

  it('falls back to title matching when seriesImdbId is absent', async () => {
    const prisma = makePrisma();
    // Owns S1E1 but only linked by title (no seriesImdbId).
    prisma.mediaItem.seed([{ id: 'i1', seriesImdbId: null, mediaType: 'tv', title: 'the wire', season: 1, episode: 1 }]);
    const svc = makeService(prisma);

    const gap = await svc.scanSeries('wl1');
    expect(gap.owned).toBe(1);
    const rows = await svc.listForSeries('wl1');
    expect(rows.find((r) => r.seasonNumber === 1 && r.episodeNumber === 1)!.status).toBe('owned');
  });

  it('preserves an ignored episode across a rescan', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    await svc.scanSeries('wl1');

    const rows = await svc.listForSeries('wl1');
    const s1e3 = rows.find((r) => r.seasonNumber === 1 && r.episodeNumber === 3)!;
    await svc.ignore(s1e3.id, 'u1');

    const gap = await svc.scanSeries('wl1'); // rescan
    expect(gap.ignored).toBe(1);
    // S1E1 + S1E2 remain missing; S1E3 stays ignored (did not revert), S2E1 unaired.
    expect(gap.missing).toBe(2);
    const after = (await svc.listForSeries('wl1')).find((r) => r.seasonNumber === 1 && r.episodeNumber === 3)!;
    expect(after.status).toBe('ignored');
  });

  it('preserves acquisition grab-state on a still-missing episode across a rescan', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    await svc.scanSeries('wl1');
    const s1e1 = (await svc.listForSeries('wl1')).find((r) => r.seasonNumber === 1 && r.episodeNumber === 1)!;
    // Simulate the auto-acquire bridge having grabbed a release for this episode.
    await prisma.wantedEpisode.update({
      where: { id: s1e1.id },
      data: { searchStatus: 'grabbed', grabbedAt: new Date(), grabbedEvaluationId: 'ev1', downloadUrl: 'magnet:x', releaseTitle: 'The Wire S01E01' },
    });

    await svc.scanSeries('wl1'); // rescan — S1E1 is still missing from the library

    const after = (await svc.listForSeries('wl1')).find((r) => r.seasonNumber === 1 && r.episodeNumber === 1)!;
    expect(after.status).toBe('missing');
    expect(after.searchStatus).toBe('grabbed');
    expect(after.grabbedEvaluationId).toBe('ev1');
    expect(after.releaseTitle).toBe('The Wire S01E01');
  });

  it('drops grab-state once a grabbed episode is owned', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    await svc.scanSeries('wl1');
    const s1e1 = (await svc.listForSeries('wl1')).find((r) => r.seasonNumber === 1 && r.episodeNumber === 1)!;
    await prisma.wantedEpisode.update({ where: { id: s1e1.id }, data: { searchStatus: 'grabbed', grabbedEvaluationId: 'ev1' } });
    // The library now owns S1E1 (the grab landed).
    prisma.mediaItem.seed([{ id: 'own', seriesImdbId: 'ttSERIES', mediaType: 'tv', title: 'The Wire', season: 1, episode: 1 }]);

    await svc.scanSeries('wl1');

    const after = (await svc.listForSeries('wl1')).find((r) => r.seasonNumber === 1 && r.episodeNumber === 1)!;
    expect(after.status).toBe('owned');
    expect(after.searchStatus).not.toBe('grabbed'); // grab-state not carried onto an owned row
  });

  it('rejects a series watchlist item with no IMDb id', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    await expect(svc.scanSeries('wl2')).rejects.toThrow(/no imdb id/i);
  });

  it('summarises per-series counts and flags unmonitorable items', async () => {
    const prisma = makePrisma();
    prisma.mediaItem.seed([{ id: 'i1', seriesImdbId: 'ttSERIES', mediaType: 'tv', title: 'The Wire', season: 1, episode: 2 }]);
    const svc = makeService(prisma);
    await svc.scanSeries('wl1');

    const summary = await svc.listGrouped();
    const wl1 = summary.find((s) => s.watchlistItemId === 'wl1')!;
    const wl2 = summary.find((s) => s.watchlistItemId === 'wl2')!;
    expect(wl1).toMatchObject({ monitorable: true, total: 4, owned: 1, missing: 2, unaired: 1 });
    expect(wl2.monitorable).toBe(false); // no imdb id
  });
});
