import { MissingMoviesService } from '../missing-movies.service';

/** Minimal in-memory Prisma stub for the missing-movie diff. */
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
      if ('equals' in cond) {
        const a = cond.mode === 'insensitive' ? String(row[k] ?? '').toLowerCase() : row[k];
        const b = cond.mode === 'insensitive' ? String(cond.equals).toLowerCase() : cond.equals;
        if (a !== b) return false;
        continue;
      }
      continue;
    }
    if (row[k] !== cond) return false;
  }
  return true;
}

class Table {
  rows: any[] = [];
  private seq = 0;
  constructor(private name: string) {}
  seed(rows: any[]) { this.rows.push(...rows); return this; }
  async findMany({ where }: any = {}) { return this.rows.filter((r) => matches(where, r)); }
  async findFirst({ where }: any = {}) { return this.rows.find((r) => matches(where, r)) ?? null; }
  async findUnique({ where }: any) { return this.rows.find((r) => matches(where, r)) ?? null; }
  async update({ where, data }: any) {
    const row = this.rows.find((r) => matches(where, r));
    Object.assign(row, data);
    return row;
  }
  async upsert({ where, create, update }: any) {
    const existing = this.rows.find((r) => matches(where, r));
    if (existing) { Object.assign(existing, update); return existing; }
    const row = { id: `${this.name}-${++this.seq}`, createdAt: new Date(), lastCheckedAt: new Date(), ...where, ...create };
    this.rows.push(row);
    return row;
  }
}

const FUTURE = new Date().getFullYear() + 5;

function makePrisma() {
  return {
    mediaAcquisitionWatchlistItem: new Table('wl').seed([
      { id: 'm1', type: 'movie', status: 'active', title: 'The Matrix', year: 1999, externalIds: { imdb: 'tt0133093' }, priority: 100 },
      { id: 'm2', type: 'movie', status: 'active', title: 'Future Film', year: FUTURE, externalIds: { imdb: 'tt9999999' }, priority: 100 },
      { id: 'm3', type: 'movie', status: 'active', title: 'No Imdb Movie', year: 2020, externalIds: {}, priority: 100 },
    ]),
    iMDbTitle: new Table('title').seed([
      { tconst: 'tt0133093', primaryTitle: 'The Matrix', startYear: 1999, titleType: 'movie' },
      { tconst: 'tt9999999', primaryTitle: 'Future Film', startYear: FUTURE, titleType: 'movie' },
    ]),
    mediaExternalId: new Table('ext'),
    mediaItem: new Table('item'),
    wantedMovie: new Table('wanted'),
  } as any;
}

function makeService(prisma: any) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const realtime = { broadcast: jest.fn() };
  return new MissingMoviesService(prisma, audit as any, realtime as any);
}

describe('MissingMoviesService', () => {
  it('marks an unowned, released movie as missing', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    const gap = await svc.scanMovie('m1');
    expect(gap.status).toBe('missing');
  });

  it('marks a future-year movie as unaired', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    const gap = await svc.scanMovie('m2');
    expect(gap.status).toBe('unaired');
  });

  it('detects ownership via the IMDb external-id link', async () => {
    const prisma = makePrisma();
    prisma.mediaItem.seed([{ id: 'i1', mediaType: 'movie', title: 'The Matrix', year: 1999 }]);
    prisma.mediaExternalId.seed([{ id: 'e1', itemId: 'i1', provider: 'imdb', externalId: 'tt0133093' }]);
    const svc = makeService(prisma);
    const gap = await svc.scanMovie('m1');
    expect(gap.status).toBe('owned');
  });

  it('falls back to a title + year match when no external id is linked', async () => {
    const prisma = makePrisma();
    prisma.mediaItem.seed([{ id: 'i1', mediaType: 'movie', title: 'the matrix', year: 1999 }]);
    const svc = makeService(prisma);
    const gap = await svc.scanMovie('m1');
    expect(gap.status).toBe('owned');
  });

  it('preserves an ignored movie across a rescan', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    await svc.scanMovie('m1');
    const w = await prisma.wantedMovie.findUnique({ where: { watchlistItemId: 'm1' } });
    await svc.ignore(w.id, 'u1');
    const gap = await svc.scanMovie('m1');
    expect(gap.status).toBe('ignored');
  });

  it('rejects a movie watchlist item with no IMDb id', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    await expect(svc.scanMovie('m3')).rejects.toThrow(/no imdb id/i);
  });

  it('summarises all movies and flags unmonitorable ones', async () => {
    const prisma = makePrisma();
    const svc = makeService(prisma);
    await svc.scanMovie('m1');
    const summary = await svc.listMissingMovies();
    expect(summary.find((s) => s.watchlistItemId === 'm1')).toMatchObject({ monitorable: true, status: 'missing' });
    expect(summary.find((s) => s.watchlistItemId === 'm3')!.monitorable).toBe(false);
  });
});
