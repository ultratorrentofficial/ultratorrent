import {
  getMediaServerProvider,
  PlexProvider,
  JellyfinProvider,
  KodiProvider,
  UnsupportedCapabilityError,
  parsePlexUsersXml,
} from './media-server-provider';

const realFetch = global.fetch;
function mockFetch(status: number, json: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  }) as unknown as typeof fetch;
}
afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

describe('media server provider factory', () => {
  it('resolves each supported kind', () => {
    expect(getMediaServerProvider('plex').kind).toBe('plex');
    expect(getMediaServerProvider('jellyfin').kind).toBe('jellyfin');
    expect(getMediaServerProvider('emby').kind).toBe('emby');
    expect(getMediaServerProvider('kodi').kind).toBe('kodi');
  });
  it('throws on an unknown kind', () => {
    expect(() => getMediaServerProvider('roku')).toThrow(/Unsupported media server/);
  });
});

describe('capabilities', () => {
  it('Plex declares full capabilities', () => {
    expect(new PlexProvider().capabilities()).toEqual({
      libraries: true, recentlyAdded: true, sessions: true, watchHistory: true, refresh: true,
    });
  });
  it('Kodi declares no library/session support', () => {
    const caps = new KodiProvider().capabilities();
    expect(caps.libraries).toBe(false);
    expect(caps.sessions).toBe(false);
    expect(caps.refresh).toBe(true);
  });
});

describe('unsupported capability is a clean typed error, not a generic failure', () => {
  it('Kodi.getLibraries throws UnsupportedCapabilityError', async () => {
    await expect(new KodiProvider().getLibraries({ baseUrl: 'http://kodi' })).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
  });
});

describe('Plex reads', () => {
  it('getServerInfo reports reachable + version + capabilities', async () => {
    mockFetch(200, { MediaContainer: { friendlyName: 'Home', version: '1.40' } });
    const info = await new PlexProvider().getServerInfo({ baseUrl: 'http://plex', token: 't' });
    expect(info).toMatchObject({ kind: 'plex', reachable: true, name: 'Home', version: '1.40' });
    expect(info.capabilities.libraries).toBe(true);
  });

  it('getLibraries maps Plex sections to typed libraries', async () => {
    mockFetch(200, {
      MediaContainer: {
        Directory: [
          { key: '1', title: 'Movies', type: 'movie' },
          { key: '2', title: 'TV Shows', type: 'show' },
          { key: '3', title: 'Music', type: 'artist' },
        ],
      },
    });
    const libs = await new PlexProvider().getLibraries({ baseUrl: 'http://plex', token: 't' });
    expect(libs).toEqual([
      { id: '1', name: 'Movies', type: 'movie' },
      { id: '2', name: 'TV Shows', type: 'show' },
      { id: '3', name: 'Music', type: 'music' },
    ]);
  });

  it('getLibraries requires a token', async () => {
    await expect(new PlexProvider().getLibraries({ baseUrl: 'http://plex' })).rejects.toThrow(/token/);
  });

  it('getSessions normalizes now-playing metadata', async () => {
    mockFetch(200, {
      MediaContainer: {
        Metadata: [
          {
            Session: { id: 'sess1' },
            User: { id: 7, title: 'alice' },
            type: 'episode',
            grandparentTitle: 'The Show',
            grandparentThumb: '/library/metadata/42/thumb/99',
            thumb: '/library/metadata/7/thumb/1',
            title: 'Pilot',
            librarySectionTitle: 'TV',
            viewOffset: 300000,
            duration: 600000,
            Player: { state: 'playing', device: 'Living Room', product: 'Plex Web', address: '10.0.0.5' },
            Media: [{ videoResolution: '1080', videoCodec: 'hevc', audioCodec: 'eac3', bitrate: 8000, container: 'mkv', Part: [{ decision: 'directplay' }] }],
          },
        ],
      },
    });
    const [s] = await new PlexProvider().getSessions({ baseUrl: 'http://plex', token: 't' });
    expect(s).toMatchObject({
      sessionId: 'sess1', userName: 'alice', title: 'The Show — Pilot', mediaType: 'episode',
      libraryName: 'TV', playbackState: 'playing', progressPercent: 50, playbackMethod: 'directplay',
      videoCodec: 'hevc', audioCodec: 'eac3', resolution: '1080',
      // Phase: stream detail + poster (prefers the show thumb for episodes).
      bitrateKbps: 8000, container: 'mkv', artPath: '/library/metadata/42/thumb/99',
    });
  });
});

describe('Kodi unsupported reads', () => {
  it('getSessions throws UnsupportedCapabilityError', async () => {
    await expect(new KodiProvider().getSessions({ baseUrl: 'http://kodi' })).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
  });
  it('getUsers throws UnsupportedCapabilityError', async () => {
    await expect(new KodiProvider().getUsers({ baseUrl: 'http://kodi' })).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
  });
});

describe('parsePlexUsersXml', () => {
  it('extracts id, name and email; managed users (empty email) come back email-less', () => {
    const xml = `<?xml version="1.0"?>
      <MediaContainer>
        <User id="11" title="Alice" username="alice" email="alice@example.com"><Server/></User>
        <User id="12" title="Kid" username="kid" email=""/>
        <User id="13" title="Bob &amp; Co" email="bob@example.com"/>
      </MediaContainer>`;
    expect(parsePlexUsersXml(xml)).toEqual([
      { providerUserId: '11', userName: 'Alice', email: 'alice@example.com' },
      { providerUserId: '12', userName: 'Kid', email: undefined },
      { providerUserId: '13', userName: 'Bob & Co', email: 'bob@example.com' },
    ]);
  });
  it('is robust to junk input', () => {
    expect(parsePlexUsersXml('not xml')).toEqual([]);
    expect(parsePlexUsersXml(undefined as unknown as string)).toEqual([]);
  });
});

// A URL-aware fetch mock: the Plex user pull hits plex.tv XML (.text()) AND the
// owner JSON endpoint (.json()); Jellyfin hits its server (.json()).
function mockFetchByUrl(handler: (url: string) => { status: number; text?: string; json?: unknown }) {
  global.fetch = jest.fn(async (url: string) => {
    const r = handler(String(url));
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.text ?? '',
      json: async () => r.json ?? null,
    };
  }) as unknown as typeof fetch;
}

describe('getUsers', () => {
  it('Plex merges shared users (with emails) and the account owner from plex.tv', async () => {
    mockFetchByUrl((url) => {
      if (url.includes('/api/users')) {
        return {
          status: 200,
          text: '<MediaContainer><User id="11" title="Alice" email="alice@example.com"/><User id="12" title="Kid" email=""/></MediaContainer>',
        };
      }
      if (url.includes('/api/v2/user')) {
        return { status: 200, json: { id: 1, title: 'Owner', email: 'owner@example.com' } };
      }
      return { status: 404 };
    });
    const users = await new PlexProvider().getUsers({ baseUrl: 'http://plex', token: 't' });
    expect(users).toEqual([
      { providerUserId: '11', userName: 'Alice', email: 'alice@example.com' },
      { providerUserId: '12', userName: 'Kid', email: undefined },
      { providerUserId: '1', userName: 'Owner', email: 'owner@example.com' },
    ]);
  });

  it('Plex requires a token', async () => {
    await expect(new PlexProvider().getUsers({ baseUrl: 'http://plex' })).rejects.toThrow(/token/);
  });

  it('Jellyfin lists users by name with no email (their model has none)', async () => {
    mockFetchByUrl((url) => {
      if (url.includes('/Users')) {
        return { status: 200, json: [{ Id: 'a1', Name: 'Alice' }, { Id: 'b2', Name: 'Bob' }, { Name: 'no-id' }] };
      }
      return { status: 404 };
    });
    const users = await new JellyfinProvider().getUsers({ baseUrl: 'http://jf', apiKey: 'k' });
    expect(users).toEqual([
      { providerUserId: 'a1', userName: 'Alice' },
      { providerUserId: 'b2', userName: 'Bob' },
    ]);
  });
});
