import { TraktSyncService } from './trakt-sync.service';
import { TraktClient } from './trakt-client';

/**
 * The two rules a sync loop must not break, both silently destructive:
 *
 *   - NEVER ECHO. A row pulled from Trakt must never be pushed back. Otherwise
 *     every sync replays a user's own history at them, re-dating watches.
 *   - DEDUPE BY ID, not by title. Two shows share the name "The Librarians"; this
 *     library has already been bitten by exactly that collision.
 */
describe('TraktSyncService', () => {
  const build = (over: Record<string, any> = {}) => {
    const posts: Array<{ path: string; body: any }> = [];
    const prisma = {
      mediaAcquisitionWatchlistItem: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      mediaUserWatch: {
        upsert: jest.fn().mockResolvedValue({ id: 'w1' }),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      mediaItem: { findMany: jest.fn().mockResolvedValue([]) },
      traktAccount: { update: jest.fn().mockResolvedValue({}) },
      ...over,
    };
    const auth = {
      accessTokenFor: jest.fn().mockResolvedValue('token'),
      credentials: jest.fn().mockResolvedValue({ clientId: 'id', clientSecret: 's' }),
    };
    const audit = { record: jest.fn(async () => undefined) };
    const svc = new TraktSyncService(prisma as any, auth as any, audit as any);
    jest.spyOn(TraktClient.prototype, 'post').mockImplementation(async (...args: unknown[]) => {
      posts.push({ path: args[0] as string, body: args[1] });
      return {};
    });
    return { svc, prisma, posts };
  };

  afterEach(() => jest.restoreAllMocks());

  describe('pagination — the silent-truncation trap', () => {
    it('pulls EVERY page of history, not just the first', async () => {
      // Trakt reports the page count in a HEADER, so a truncated first page looks
      // exactly like a complete result. This shipped broken: a real 11,297-entry
      // history synced as its most recent 1,000 and reported success.
      const { svc, prisma } = build();
      const page = (n: number) => [
        {
          type: 'episode',
          watched_at: '2026-07-01T10:00:00Z',
          show: { title: 'Silo' },
          episode: { season: 1, number: n, ids: { tvdb: 9000 + n } },
        },
      ];
      const fetched: string[] = [];
      jest
        .spyOn(TraktClient.prototype as any, 'call')
        .mockImplementation(async (...args: unknown[]) => {
          const path = args[0] as string;
          fetched.push(path);
          const p = Number(/page=(\d+)/.exec(path)?.[1] ?? 1);
          return { status: 200, json: page(p), pageCount: 3 };
        });

      const summary = await svc.syncWatched('u1');

      // Three pages requested, three entries pulled — not one.
      expect(fetched.filter((p) => p.startsWith('/sync/history'))).toHaveLength(3);
      expect(summary.pulled).toBe(3);
      expect(prisma.mediaUserWatch.upsert).toHaveBeenCalledTimes(3);
    });
  });

  describe('watched state', () => {
    it('pulls Trakt history and stamps it as already synced — so it is never echoed back', async () => {
      const { svc, prisma, posts } = build();
      jest.spyOn(TraktClient.prototype, 'getAll').mockResolvedValue({
        items: [
          {
            type: 'episode',
            watched_at: '2026-07-01T10:00:00Z',
            show: { title: 'Silo', year: 2023 },
            episode: { season: 1, number: 3, title: 'Freedom Day', ids: { tvdb: 9001 } },
          },
        ],
        pages: 1,
        truncated: false,
      } as any);

      const summary = await svc.syncWatched('u1');

      expect(summary.pulled).toBe(1);
      const created = prisma.mediaUserWatch.upsert.mock.calls[0][0].create;
      expect(created.source).toBe('trakt');
      expect(created.syncedAt).toBeInstanceOf(Date); // ← the echo guard
      expect(created.key).toBe('tvdb:9001/s1e3');
      // Nothing was pushed: their own history is not ours to send back.
      expect(posts).toEqual([]);
    });

    it('pushes only OUR unsynced watches, never Trakt-sourced ones', async () => {
      const { svc, prisma, posts } = build({
        mediaUserWatch: {
          upsert: jest.fn(),
          // First batch has the row; after it is stamped synced the working set
          // is empty — mirroring what updateMany does in the real query.
          findMany: jest
            .fn()
            .mockResolvedValueOnce([
              {
                id: 'w1',
                mediaType: 'episode',
                imdbId: null,
                tmdbId: null,
                tvdbId: '9001',
                watchedAt: new Date('2026-07-02T10:00:00Z'),
              },
            ])
            .mockResolvedValue([]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      jest.spyOn(TraktClient.prototype, 'getAll').mockResolvedValue({ items: [], pages: 1, truncated: false } as any);

      const summary = await svc.syncWatched('u1');

      // The query itself must exclude Trakt-sourced and already-synced rows.
      expect(prisma.mediaUserWatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ syncedAt: null, source: { not: 'trakt' } }),
        }),
      );
      expect(summary.pushed).toBe(1);
      expect(posts[0].path).toBe('/sync/history');
      expect(posts[0].body.episodes[0]).toMatchObject({ ids: { tvdb: 9001 } });
      // Pushed rows are stamped, so the next sync does not send them again.
      expect(prisma.mediaUserWatch.updateMany).toHaveBeenCalled();
    });

    it('skips a watch it cannot identify rather than guessing at one', async () => {
      const { svc, posts } = build({
        mediaUserWatch: {
          upsert: jest.fn(),
          findMany: jest
            .fn()
            .mockResolvedValueOnce([
              { id: 'w1', mediaType: 'episode', imdbId: null, tmdbId: null, tvdbId: null, watchedAt: new Date() },
            ])
            .mockResolvedValue([]),
          updateMany: jest.fn(),
        },
      });
      jest.spyOn(TraktClient.prototype, 'getAll').mockResolvedValue({ items: [], pages: 1, truncated: false } as any);

      const summary = await svc.syncWatched('u1');

      expect(summary.skipped).toBe(1);
      expect(summary.pushed).toBe(0);
      expect(posts).toEqual([]);
    });
  });

  describe('watchlist import', () => {
    const traktWatchlist = [
      {
        type: 'show',
        show: { title: 'Silo', year: 2023, ids: { imdb: 'tt14688458', tmdb: 125988, trakt: 1 } },
      },
    ];

    it('creates an acquisition item CARRYING the external ids — the identity gates need them', async () => {
      const { svc, prisma } = build();
      jest.spyOn(TraktClient.prototype, 'getAll').mockResolvedValue({ items: traktWatchlist, pages: 1, truncated: false } as any);

      const summary = await svc.importWatchlist('u1');

      expect(summary.imported).toBe(1);
      const created = prisma.mediaAcquisitionWatchlistItem.create.mock.calls[0][0].data;
      expect(created).toMatchObject({
        type: 'series',
        title: 'Silo',
        year: 2023,
        status: 'active',
        externalIds: { imdb: 'tt14688458', tmdb: '125988', trakt: '1' },
      });
      // A title-only item is how the wrong show gets hunted; ids are the guard.
      expect(created.externalIds.imdb).toBeTruthy();
    });

    it('dedupes against an existing item by EXTERNAL ID, not by title', async () => {
      const { svc, prisma } = build({
        mediaAcquisitionWatchlistItem: {
          findFirst: jest.fn().mockResolvedValue({ id: 'existing', externalIds: { imdb: 'tt14688458' } }),
          create: jest.fn(),
          update: jest.fn(),
        },
      });
      jest.spyOn(TraktClient.prototype, 'getAll').mockResolvedValue({ items: traktWatchlist, pages: 1, truncated: false } as any);

      const summary = await svc.importWatchlist('u1');

      expect(summary.alreadyPresent).toBe(1);
      expect(prisma.mediaAcquisitionWatchlistItem.create).not.toHaveBeenCalled();
      // The id lookup must run before any title lookup.
      expect(prisma.mediaAcquisitionWatchlistItem.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { externalIds: { path: ['imdb'], equals: 'tt14688458' } },
        }),
      );
    });

    it('backfills ids onto an existing title-only item — upgrading it from fuzzy to identified', async () => {
      const { svc, prisma } = build({
        mediaAcquisitionWatchlistItem: {
          findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
            id: 'title-only',
            externalIds: null,
          }),
          create: jest.fn(),
          update: jest.fn().mockResolvedValue({}),
        },
      });
      jest.spyOn(TraktClient.prototype, 'getAll').mockResolvedValue({ items: traktWatchlist, pages: 1, truncated: false } as any);

      await svc.importWatchlist('u1');

      expect(prisma.mediaAcquisitionWatchlistItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'title-only' },
          data: { externalIds: { imdb: 'tt14688458', tmdb: '125988', trakt: '1' } },
        }),
      );
    });
  });

  describe('collection push', () => {
    it('sends only items with a real id, and groups episodes under their show', async () => {
      const { svc, posts } = build({
        mediaItem: {
          findMany: jest.fn().mockResolvedValue([
            {
              mediaType: 'tv', season: 1, episode: 1, title: 'Silo', year: 2023,
              externalIds: [{ provider: 'tvdb', externalId: '400' }],
            },
            {
              mediaType: 'tv', season: 1, episode: 2, title: 'Silo', year: 2023,
              externalIds: [{ provider: 'tvdb', externalId: '400' }],
            },
            {
              mediaType: 'movie', season: null, episode: null, title: 'The Matrix', year: 1999,
              externalIds: [{ provider: 'imdb', externalId: 'tt0133093' }],
            },
            // No ids at all: Trakt would fuzzy-match this into the wrong film.
            { mediaType: 'movie', season: null, episode: null, title: 'Unknown', year: null, externalIds: [] },
          ]),
        },
      });

      const summary = await svc.pushCollection('u1');

      expect(summary.skipped).toBe(1);
      const body = posts[0].body;
      expect(posts[0].path).toBe('/sync/collection');
      expect(body.movies).toEqual([{ ids: { imdb: 'tt0133093' } }]);
      // Both episodes land under ONE show, not as two shows.
      expect(body.shows).toHaveLength(1);
      expect(body.shows[0]).toEqual({
        ids: { tvdb: 400 },
        seasons: [{ number: 1, episodes: [{ number: 1 }, { number: 2 }] }],
      });
    });
  });
});
