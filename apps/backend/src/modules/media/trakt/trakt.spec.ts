import {
  TraktPollError,
  buildScrobbleBody,
  hasAnyId,
  toTraktIds,
} from './trakt-client';
import { watchKey } from './trakt-sync.service';
import { TraktScrobbleService, WATCHED_THRESHOLD_PCT } from './trakt-scrobble.service';
import { parseJellyfinProviderIds, parsePlexGuids } from '../media-server-provider';

/**
 * Trakt writes to someone's real account. Every test here guards a way of being
 * silently WRONG rather than merely broken — marking the wrong show watched,
 * echoing a user's own history back at them, or duplicating every row on each
 * sync. Those are not failures you can quietly fix afterwards.
 */

describe('toTraktIds', () => {
  it('keeps the ids Trakt can match on and coerces the numeric ones', () => {
    expect(toTraktIds({ imdb: 'tt0944947', tmdb: '1399', tvdb: '121361' })).toEqual({
      imdb: 'tt0944947',
      tmdb: 1399,
      tvdb: 121361,
    });
  });

  it('drops a non-numeric tmdb/tvdb id rather than send a string', () => {
    // Trakt silently ignores an ids object it cannot parse — and then matches on
    // NOTHING, which is worse than us noticing we have no id.
    expect(toTraktIds({ tmdb: 'not-a-number' })).toEqual({});
    expect(toTraktIds({ imdb: '12345' })).toEqual({}); // not a tconst
    expect(toTraktIds(null)).toEqual({});
    expect(hasAnyId({})).toBe(false);
  });
});

describe('buildScrobbleBody', () => {
  it('identifies an episode by its own ids when it has them', () => {
    const body = buildScrobbleBody(
      { mediaType: 'episode', externalIds: { tvdb: '3254641' }, seasonNumber: 1, episodeNumber: 1 },
      42,
    );

    expect(body).toEqual({ episode: { ids: { tvdb: 3254641 } }, progress: 42 });
  });

  it('falls back to show title + season/number when the episode has no ids', () => {
    const body = buildScrobbleBody(
      {
        mediaType: 'episode',
        showTitle: 'Silo',
        seasonNumber: 2,
        episodeNumber: 3,
        year: 2023,
        externalIds: {},
      },
      55,
    );

    expect(body).toEqual({
      show: { title: 'Silo', year: 2023 },
      episode: { season: 2, number: 3 },
      progress: 55,
    });
  });

  it('REFUSES to scrobble an episode it cannot identify', () => {
    // The whole point: Trakt would happily fuzzy-match a bare title and mark
    // something watched. Scrobbling nothing beats polluting a history with a guess.
    expect(
      buildScrobbleBody({ mediaType: 'episode', title: 'Some Episode', externalIds: {} }, 90),
    ).toBeNull();
  });

  it('identifies a movie by ids, else by title + year', () => {
    expect(buildScrobbleBody({ mediaType: 'movie', externalIds: { imdb: 'tt0133093' } }, 10)).toEqual(
      { movie: { ids: { imdb: 'tt0133093' } }, progress: 10 },
    );
    expect(
      buildScrobbleBody({ mediaType: 'movie', title: 'The Matrix', year: 1999, externalIds: {} }, 10),
    ).toEqual({ movie: { title: 'The Matrix', year: 1999 }, progress: 10 });
  });

  it('clamps progress into Trakt’s range', () => {
    const over = buildScrobbleBody({ mediaType: 'movie', externalIds: { imdb: 'tt1' } }, 140) as any;
    const under = buildScrobbleBody({ mediaType: 'movie', externalIds: { imdb: 'tt1' } }, -5) as any;
    expect(over.progress).toBe(100);
    expect(under.progress).toBe(0);
  });
});

describe('watchKey', () => {
  it('prefers a real id, and keeps an episode’s numbering in the key', () => {
    expect(watchKey({ imdbId: 'tt0944947' })).toBe('imdb:tt0944947');
    expect(watchKey({ imdbId: 'tt0944947', season: 1, episode: 2 })).toBe('imdb:tt0944947/s1e2');
    expect(watchKey({ tmdbId: '1399', season: 2, episode: 5 })).toBe('tmdb:1399/s2e5');
  });

  it('separates two episodes of the same show — a show-level key would collapse a series', () => {
    const e1 = watchKey({ tvdbId: '121361', season: 1, episode: 1 });
    const e2 = watchKey({ tvdbId: '121361', season: 1, episode: 2 });
    expect(e1).not.toBe(e2);
  });

  it('falls back to a normalised title so a title-only item still dedupes against itself', () => {
    // Without this, an item with no ids re-imports on every single sync.
    expect(watchKey({ showTitle: '  The   Librarians ', year: 2014, season: 1, episode: 1 })).toBe(
      'title:the librarians (2014)/s1e1',
    );
    expect(watchKey({ title: 'The Matrix', year: 1999 })).toBe('title:the matrix (1999)');
  });
});

describe('media-server id parsing (what makes a correct scrobble possible)', () => {
  it('reads Plex’s guid URIs', () => {
    expect(
      parsePlexGuids([
        { id: 'imdb://tt0944947' },
        { id: 'tmdb://1399' },
        { id: 'tvdb://121361' },
        { id: 'plex://show/5d9c' }, // not an external id — ignored
      ]),
    ).toEqual({ imdb: 'tt0944947', tmdb: '1399', tvdb: '121361' });
    expect(parsePlexGuids(undefined)).toEqual({});
  });

  it('reads Jellyfin’s ProviderIds, whatever the casing', () => {
    expect(parseJellyfinProviderIds({ Imdb: 'tt0944947', Tmdb: '1399', Unknown: 'x' })).toEqual({
      imdb: 'tt0944947',
      tmdb: '1399',
    });
    expect(parseJellyfinProviderIds(null)).toEqual({});
  });
});

describe('TraktScrobbleService', () => {
  const account = {
    userId: 'u1',
    scrobbleEnabled: true,
    mediaServerUserName: 'dennis',
  };

  const session = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    userName: 'dennis',
    title: 'Silo — Freedom Day',
    showTitle: 'Silo',
    mediaType: 'episode',
    seasonNumber: 1,
    episodeNumber: 3,
    externalIds: { tvdb: '9001' },
    playbackState: 'playing',
    progressPercent: 10,
    ...over,
  });

  const build = (sessions: any[]) => {
    const posts: Array<{ path: string; body: any }> = [];
    const prisma = {
      traktAccount: { findMany: jest.fn().mockResolvedValue([account]) },
      mediaServerSession: { findMany: jest.fn().mockResolvedValue(sessions) },
      mediaUserWatch: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const auth = {
      credentials: jest.fn().mockResolvedValue({ clientId: 'id', clientSecret: 'secret' }),
      accessTokenFor: jest.fn().mockResolvedValue('token'),
    };
    const svc = new TraktScrobbleService(prisma as any, auth as any);
    // Intercept the HTTP layer at the client boundary.
    jest
      .spyOn(require('./trakt-client').TraktClient.prototype, 'post')
      .mockImplementation(async (...args: unknown[]) => {
        posts.push({ path: args[0] as string, body: args[1] });
        return {};
      });
    return { svc, prisma, posts };
  };

  afterEach(() => jest.restoreAllMocks());

  it('starts a scrobble for a playing session, ONCE — not on every tick', async () => {
    const { svc, posts } = build([session()]);

    await svc.sweep();
    await svc.sweep(); // same state — Trakt must not be told again

    expect(posts.map((p) => p.path)).toEqual(['/scrobble/start']);
    expect(posts[0].body).toMatchObject({ episode: { ids: { tvdb: 9001 } } });
  });

  it('pauses when the player pauses, and resumes on a start', async () => {
    const posts: string[] = [];
    const prisma = {
      traktAccount: { findMany: jest.fn().mockResolvedValue([account]) },
      mediaServerSession: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([session()])
          .mockResolvedValueOnce([session({ playbackState: 'paused' })])
          .mockResolvedValueOnce([session({ playbackState: 'playing' })]),
      },
      mediaUserWatch: { upsert: jest.fn() },
    };
    const auth = {
      credentials: jest.fn().mockResolvedValue({ clientId: 'id', clientSecret: 's' }),
      accessTokenFor: jest.fn().mockResolvedValue('token'),
    };
    jest
      .spyOn(require('./trakt-client').TraktClient.prototype, 'post')
      .mockImplementation(async (...args: unknown[]) => {
        posts.push(args[0] as string);
        return {};
      });
    const svc = new TraktScrobbleService(prisma as any, auth as any);

    await svc.sweep();
    await svc.sweep();
    await svc.sweep();

    expect(posts).toEqual(['/scrobble/start', '/scrobble/pause', '/scrobble/start']);
  });

  it('treats a VANISHED session as a stop, and marks it watched past the threshold', async () => {
    // Players don't announce that they stopped — the session just disappears.
    const prisma = {
      traktAccount: { findMany: jest.fn().mockResolvedValue([account]) },
      mediaServerSession: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([session({ progressPercent: 95 })])
          .mockResolvedValueOnce([]), // gone
      },
      mediaUserWatch: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const auth = {
      credentials: jest.fn().mockResolvedValue({ clientId: 'id', clientSecret: 's' }),
      accessTokenFor: jest.fn().mockResolvedValue('token'),
    };
    const posts: Array<{ path: string; body: any }> = [];
    jest
      .spyOn(require('./trakt-client').TraktClient.prototype, 'post')
      .mockImplementation(async (...args: unknown[]) => {
        posts.push({ path: args[0] as string, body: args[1] });
        return {};
      });
    const svc = new TraktScrobbleService(prisma as any, auth as any);

    await svc.sweep();
    await svc.sweep();

    expect(posts.map((p) => p.path)).toEqual(['/scrobble/start', '/scrobble/stop']);
    expect(posts[1].body.progress).toBe(95); // last known progress, not zero

    // ...and the local watch row is stamped as ALREADY synced: the scrobble is how
    // Trakt found out, so pushing it again would re-date their history.
    const created = prisma.mediaUserWatch.upsert.mock.calls[0][0].create;
    expect(created.source).toBe('media_server');
    expect(created.syncedAt).toBeInstanceOf(Date);
    expect(WATCHED_THRESHOLD_PCT).toBe(80);
  });

  it('does NOT mark watched when the play was abandoned early', async () => {
    const prisma = {
      traktAccount: { findMany: jest.fn().mockResolvedValue([account]) },
      mediaServerSession: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([session({ progressPercent: 12 })])
          .mockResolvedValueOnce([]),
      },
      mediaUserWatch: { upsert: jest.fn() },
    };
    const auth = {
      credentials: jest.fn().mockResolvedValue({ clientId: 'id', clientSecret: 's' }),
      accessTokenFor: jest.fn().mockResolvedValue('token'),
    };
    jest.spyOn(require('./trakt-client').TraktClient.prototype, 'post').mockResolvedValue({});
    const svc = new TraktScrobbleService(prisma as any, auth as any);

    await svc.sweep();
    await svc.sweep();

    expect(prisma.mediaUserWatch.upsert).not.toHaveBeenCalled();
  });

  it('ignores a session belonging to someone who has not linked scrobbling', async () => {
    const { svc, posts } = build([session({ userName: 'a-different-person' })]);

    await svc.sweep();

    // Guessing here would put one person's viewing in another person's history.
    expect(posts).toEqual([]);
  });

  it('does not scrobble an item it cannot identify', async () => {
    const { svc, posts } = build([
      session({ externalIds: {}, showTitle: null, seasonNumber: null, episodeNumber: null }),
    ]);

    await svc.sweep();

    expect(posts).toEqual([]);
  });
});

describe('TraktClient HTTP headers', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('sends a User-Agent — without one, Cloudflare 403s the request before it reaches Trakt', async () => {
    // This is not cosmetic. Node's fetch (undici) sends NO User-Agent, and the CDN
    // in front of api.trakt.tv answers that with a 403 HTML challenge page. It cost
    // a live debugging session: the error surfaced as "Trakt rejected the client ID"
    // against a client ID that was perfectly valid.
    let sent: Record<string, string> = {};
    global.fetch = jest.fn(async (_url: any, init: any) => {
      sent = init.headers;
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ device_code: 'd', user_code: 'U', verification_url: 'x', expires_in: 600, interval: 5 }),
      };
    }) as any;

    const { TraktClient } = require('./trakt-client');
    await new TraktClient({ clientId: 'id', clientSecret: 'secret' }).requestDeviceCode();

    expect(sent['User-Agent']).toBeTruthy();
    expect(sent['trakt-api-version']).toBe('2');
    expect(sent['trakt-api-key']).toBe('id');
  });

  it('does not blame the credentials for a CDN block (403 with a non-JSON body)', async () => {
    global.fetch = jest.fn(async () => ({
      status: 403,
      headers: { get: () => null },
      text: async () => '<!DOCTYPE html><html>Cloudflare</html>',
    })) as any;

    const { TraktClient } = require('./trakt-client');
    const client = new TraktClient({ clientId: 'id', clientSecret: 'secret' });

    await expect(client.requestDeviceCode()).rejects.toThrow(/CDN|not a credentials problem/i);
  });

  it('DOES blame the credentials for a real 403 from Trakt (a JSON body)', async () => {
    global.fetch = jest.fn(async () => ({
      status: 403,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: 'invalid_client' }),
    })) as any;

    const { TraktClient } = require('./trakt-client');
    const client = new TraktClient({ clientId: 'bad', clientSecret: 'secret' });

    await expect(client.requestDeviceCode()).rejects.toThrow(/client ID/i);
  });
});

describe('TraktPollError', () => {
  it('carries the device-flow status verbatim, because each one means something different', () => {
    // pending → keep polling; slow_down → back off; denied/expired → stop.
    // Collapsing these into "failed" is what gets an app throttled by Trakt.
    expect(new TraktPollError('slow_down').status).toBe('slow_down');
    expect(new TraktPollError('denied').status).toBe('denied');
  });
});
