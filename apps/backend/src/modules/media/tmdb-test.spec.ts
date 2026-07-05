import { TmdbMetadataProvider } from './metadata-provider';
import { MediaService } from './media.service';

/**
 * Covers the "Test TMDB key" flow: the provider's verify() probe against the
 * live-shaped endpoint and MediaService.testTmdbKey's key-selection + auditing.
 */
describe('TmdbMetadataProvider.verify', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('reports a valid key on HTTP 200', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 })) as any;
    const res = await new TmdbMetadataProvider('good').verify();
    expect(res.ok).toBe(true);
    // The probe hits the authentication endpoint with the key as api_key.
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as URL;
    expect(url.pathname).toBe('/3/authentication');
    expect(url.searchParams.get('api_key')).toBe('good');
  });

  it('reports an invalid key on HTTP 401', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 401 })) as any;
    const res = await new TmdbMetadataProvider('bad').verify();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/401/);
  });

  it('reports unreachable TMDB on a network error', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as any;
    const res = await new TmdbMetadataProvider('x').verify();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/could not reach tmdb/i);
  });
});

describe('MediaService.testTmdbKey', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const build = (savedKey?: string) => {
    const audit = { record: jest.fn(async () => undefined) };
    const settings = { get: jest.fn(async () => savedKey) };
    const svc = new MediaService(
      null as any,
      null as any,
      settings as any,
      null as any,
      audit as any,
    );
    return { svc, audit, settings };
  };

  it('tests the supplied (unsaved) key and audits success', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 })) as any;
    const { svc, audit, settings } = build('saved-key');
    const res = await svc.testTmdbKey('typed-key', { userId: 'u1' });
    expect(res.ok).toBe(true);
    // Supplied key wins over the saved one — settings is never consulted.
    expect(settings.get).not.toHaveBeenCalled();
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as URL;
    expect(url.searchParams.get('api_key')).toBe('typed-key');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'success', action: 'media.tmdb.key_tested' }),
    );
  });

  it('falls back to the saved key when none is supplied', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 })) as any;
    const { svc, settings } = build('saved-key');
    const res = await svc.testTmdbKey(undefined, {});
    expect(res.ok).toBe(true);
    expect(settings.get).toHaveBeenCalledWith('media.tmdbApiKey');
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as URL;
    expect(url.searchParams.get('api_key')).toBe('saved-key');
  });

  it('returns a clear message and never calls TMDB when no key exists', async () => {
    global.fetch = jest.fn() as any;
    const prevEnv = process.env.TMDB_API_KEY;
    delete process.env.TMDB_API_KEY;
    const { svc, audit } = build(undefined);
    const res = await svc.testTmdbKey('   ', {});
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/no tmdb api key/i);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ result: 'failure' }));
    if (prevEnv !== undefined) process.env.TMDB_API_KEY = prevEnv;
  });
});
