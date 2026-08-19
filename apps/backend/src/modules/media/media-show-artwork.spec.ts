/**
 * Artwork that belongs to a SHOW, and to one of its seasons.
 *
 * Television artwork was written onto every episode — one live library holds 49
 * identical posters for a 49-episode show — so "the show's poster" was whichever
 * episode row sorted first, and choosing one was not an operation the model
 * could express.
 */
import { MediaArtworkService } from './media-artwork.service';

function build(rows: Array<Record<string, unknown>> = []) {
  const artwork = [...rows];
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    mediaItem: { findUnique: jest.fn(async () => ({ id: 'i1', mediaType: 'tv' })) },
    mediaShow: { findUnique: jest.fn(async () => ({ id: 's1', title: 'Show', tmdbId: null })) },
    mediaArtwork: {
      findMany: jest.fn(async ({ where }: never) =>
        artwork.filter((a) => matches(a, (where ?? {}) as Record<string, unknown>)),
      ),
      findFirst: jest.fn(async ({ where }: never) =>
        artwork.find((a) => matches(a, (where ?? {}) as Record<string, unknown>)) ?? null,
      ),
      updateMany: jest.fn(async (args: never) => {
        updates.push(args as Record<string, unknown>);
        return { count: 0 };
      }),
      update: jest.fn(async () => ({})),
      create: jest.fn(async ({ data }: never) => data),
    },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const svc = new MediaArtworkService(
    prisma as never,
    { hardRoots: ['/data'], assertWithinHardRoots: (p: string) => p } as never,
    audit as never,
    { get: async () => null } as never,
  );
  return { svc, prisma, audit, updates };
}

/** Mirrors the subset of Prisma filtering these cases use. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => (v === undefined ? true : row[k] === v));
}

const art = (over: Record<string, unknown>) => ({
  id: 'a1', itemId: null, showId: null, seasonNumber: null, type: 'poster', selected: false, ...over,
});

describe('artwork owned by a show', () => {
  it('lists the show’s own rows and not its seasons’', async () => {
    // A season poster is a show-owned row WITH a season, so "the show's
    // artwork" must mean seasonNumber IS NULL, not "any row of this show".
    const { svc } = build([
      art({ id: 'show-poster', showId: 's1', seasonNumber: null }),
      art({ id: 'season-2-poster', showId: 's1', seasonNumber: 2, type: 'season_poster' }),
    ]);

    const res = await svc.listFor({ kind: 'show', showId: 's1' });

    expect(res.artwork.map((a) => a.id)).toEqual(['show-poster']);
  });

  it('lists one season’s rows in isolation', async () => {
    const { svc } = build([
      art({ id: 'show-poster', showId: 's1', seasonNumber: null }),
      art({ id: 's2', showId: 's1', seasonNumber: 2, type: 'season_poster' }),
      art({ id: 's3', showId: 's1', seasonNumber: 3, type: 'season_poster' }),
    ]);

    const res = await svc.listFor({ kind: 'show', showId: 's1', seasonNumber: 2 });

    expect(res.artwork.map((a) => a.id)).toEqual(['s2']);
  });

  it('unselects within the season being changed, never the whole show', async () => {
    /*
     * The trap: unselecting by type alone would clear the show's chosen poster
     * when a season's is picked, and vice versa. The scope has to travel with
     * the update.
     */
    const { svc, updates } = build([art({ id: 'a1', showId: 's1', seasonNumber: 2, type: 'season_poster' })]);

    await svc.selectFor({ kind: 'show', showId: 's1', seasonNumber: 2 }, 'a1');

    expect(updates[0].where).toMatchObject({ showId: 's1', seasonNumber: 2, type: 'season_poster' });
  });

  it('refuses artwork that belongs to another owner', async () => {
    // The row exists, but not in this scope; selecting it would move a season's
    // image onto the show.
    const { svc } = build([art({ id: 'a1', showId: 's1', seasonNumber: 5 })]);

    await expect(svc.selectFor({ kind: 'show', showId: 's1' }, 'a1')).rejects.toThrow(/not found/i);
  });

  it('records the show, not a media_item, in the audit trail', async () => {
    const { svc, audit } = build([art({ id: 'a1', showId: 's1' })]);

    await svc.selectFor({ kind: 'show', showId: 's1' }, 'a1', { userId: 'u1' });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ objectType: 'media_show', objectId: 's1' }),
    );
  });

  it('keeps item selection working exactly as before', async () => {
    const { svc, updates } = build([art({ id: 'a1', itemId: 'i1', type: 'poster' })]);

    await svc.selectFor({ kind: 'item', itemId: 'i1' }, 'a1');

    expect(updates[0].where).toMatchObject({ itemId: 'i1', type: 'poster' });
  });
});

/**
 * Reported: "fetch artwork is not downloading the season cover artwork".
 * `/tv/{id}/images` holds the SERIES' posters and knows nothing about season 2,
 * so a season scope asking it received the show's art — filed under the season,
 * while the season cover never arrived.
 */
describe('TmdbArtworkProvider season posters', () => {
  const { TmdbArtworkProvider } = jest.requireActual('./artwork-provider') as {
    TmdbArtworkProvider: new (k: string) => {
      get: (p: string) => Promise<unknown>;
      listSeasonPosters: (id: string, s: number) => Promise<Array<Record<string, unknown>>>;
      list: (k: 'movie' | 'tv', id: string) => Promise<Array<Record<string, unknown>>>;
    };
  };

  function provider(calls: string[]) {
    const p = new TmdbArtworkProvider('key');
    p.get = async (path: string) => {
      calls.push(path);
      if (path.includes('/season/')) {
        return { posters: [{ file_path: '/s2.jpg', width: 600, height: 900, vote_average: 7 }] };
      }
      return { posters: [{ file_path: '/series.jpg' }], backdrops: [], logos: [] };
    };
    return p;
  }

  it('asks the season endpoint, not the series one', async () => {
    const calls: string[] = [];
    const out = await provider(calls).listSeasonPosters('82974', 2);

    expect(calls).toEqual(['/tv/82974/season/2/images']);
    expect(out[0]).toMatchObject({ type: 'season_poster', seasonNumber: 2 });
    expect(out[0].url).toContain('/s2.jpg');
  });

  it('returns nothing rather than the series poster when a season has none', async () => {
    // Falling back to the show's poster would file the wrong image as the
    // season's cover, which is exactly the confusion being fixed.
    const p = new TmdbArtworkProvider('key');
    p.get = async () => ({ posters: [] });
    expect(await p.listSeasonPosters('82974', 5)).toEqual([]);
  });
});
