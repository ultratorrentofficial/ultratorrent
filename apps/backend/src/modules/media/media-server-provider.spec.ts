import {
  getMediaServerProvider,
  PlexProvider,
  KodiProvider,
  UnsupportedCapabilityError,
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
});
