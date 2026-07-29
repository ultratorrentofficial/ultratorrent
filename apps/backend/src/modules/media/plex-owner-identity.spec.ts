/**
 * The Plex server owner has two identities, and only one boundary knows it.
 *
 * Reported as "the live activity page shows the user name instead of full
 * name". The display was the visible half; the real defect was an identity
 * split. `/status/sessions` reports the owner as local account `1` under their
 * login HANDLE, while the plex.tv account list reports the same person under
 * their global id and friendly name. Untranslated, one person becomes two
 * `MediaServerUser` rows — and the existing `dedupeUsersByProviderId` cannot
 * merge them, because it keys on the id that differs.
 *
 * These tests drive the provider through a stubbed `fetch`, so they pin the
 * translation itself rather than any downstream rendering.
 */
import { PlexProvider, __resetPlexOwnerCache } from './media-server-provider';

const cfg = { baseUrl: 'http://plex.local:32400', token: 'tok-1' } as never;

const OWNER = { id: 383757, title: 'Jane Smith', username: 'j.smith', email: 'jane@example.com' };

/** One session, attributed to whichever `User` element is passed. */
const sessions = (user: Record<string, unknown>) => ({
  MediaContainer: {
    Metadata: [
      { sessionKey: '9', ratingKey: '11', title: 'The Lantern Problem', type: 'movie', User: user },
    ],
  },
});

type Route = { json?: unknown; text?: string; ok?: boolean };
let routes: Record<string, Route>;
let calls: string[];

beforeEach(() => {
  __resetPlexOwnerCache();
  calls = [];
  routes = {
    '/status/sessions': { json: sessions({ id: 1, title: 'j.smith' }) },
    'plex.tv/api/v2/user': { json: OWNER },
    'plex.tv/api/users': { text: '<MediaContainer></MediaContainer>' },
  };
  global.fetch = jest.fn(async (url: string) => {
    calls.push(String(url));
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    const route = key ? routes[key] : undefined;
    if (!route) throw new Error(`unstubbed ${url}`);
    return {
      ok: route.ok ?? true,
      status: (route.ok ?? true) ? 200 : 500,
      json: async () => route.json,
      text: async () => route.text ?? JSON.stringify(route.json),
    };
  }) as never;
});

const provider = () => new PlexProvider();

describe('owner identity in sessions', () => {
  it('reports the owner under their friendly name, not their login handle', async () => {
    const [s] = await provider().getSessions(cfg);
    expect(s.userName).toBe('Jane Smith');
  });

  it('reports the owner under their global id, not local id 1', async () => {
    // This is the half that matters beyond the display: `providerUserId` is
    // what watch history and the user list join on.
    const [s] = await provider().getSessions(cfg);
    expect(s.userId).toBe('383757');
  });

  it('leaves every other user exactly as the server reported them', async () => {
    // Shared users already carry their global id and friendly name — touching
    // them would be a regression, not a fix.
    routes['/status/sessions'] = { json: sessions({ id: 55, title: 'Madeline Ayala' }) };
    const [s] = await provider().getSessions(cfg);
    expect(s.userName).toBe('Madeline Ayala');
    expect(s.userId).toBe('55');
  });

  it('falls back to the local values when plex.tv cannot be reached', async () => {
    // An offline or token-revoked server must still show live activity; a
    // handle is worse than a name but far better than an empty session list.
    routes['plex.tv/api/v2/user'] = { ok: false, json: {} };
    const [s] = await provider().getSessions(cfg);
    expect(s.userName).toBe('j.smith');
    expect(s.userId).toBe('1');
  });

  it('makes no plex.tv call when the owner is not streaming', async () => {
    // Sessions are polled continuously; an unconditional lookup would be a
    // plex.tv round trip every few seconds.
    routes['/status/sessions'] = { json: sessions({ id: 55, title: 'Madeline Ayala' }) };
    await provider().getSessions(cfg);
    expect(calls.some((u) => u.includes('plex.tv'))).toBe(false);
  });

  it('resolves the owner once and caches it across polls', async () => {
    await provider().getSessions(cfg);
    await provider().getSessions(cfg);
    await provider().getSessions(cfg);
    expect(calls.filter((u) => u.includes('plex.tv/api/v2/user'))).toHaveLength(1);
  });

  it('caches a failed lookup too, rather than retrying every poll', async () => {
    routes['plex.tv/api/v2/user'] = { ok: false, json: {} };
    await provider().getSessions(cfg);
    await provider().getSessions(cfg);
    expect(calls.filter((u) => u.includes('plex.tv/api/v2/user'))).toHaveLength(1);
  });
});

describe('the account list agrees with the session path', () => {
  it('lists the owner under the same id sessions now report', async () => {
    /*
     * The whole point: both halves must land on one id, or the two rows the
     * bug created simply come back under different names.
     */
    const users = await provider().getUsers(cfg);
    const owner = users.find((u) => u.userName === 'Jane Smith');
    expect(owner?.providerUserId).toBe('383757');

    const [s] = await provider().getSessions(cfg);
    expect(s.userId).toBe(owner?.providerUserId);
  });

  it('still carries the owner email', async () => {
    const users = await provider().getUsers(cfg);
    expect(users.find((u) => u.userName === 'Jane Smith')?.email).toBe('jane@example.com');
  });
});
