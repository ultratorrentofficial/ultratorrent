import {
  DEFAULT_ORDER,
  MetadataProviderRegistry,
  resolveChain,
} from './metadata-provider-registry.service';

/**
 * The registry's job is to answer one question — "who do I ask, and in what
 * order?" — and to answer it the same way every time. Two properties matter:
 * an UNCONFIGURED provider must never appear in a chain (it would burn a lookup
 * to fail), and a provider instance must be REUSED, because TVDB authenticates
 * once and caches a bearer token for weeks; a fresh instance per lookup would
 * re-login on every item of a 29,000-file library.
 */
describe('resolveChain', () => {
  const both = { tmdbApiKey: 'tm', tvdbApiKey: 'tv' };

  it('leads with TVDB for television and TMDB for film', () => {
    // TVDB is the stronger TV source (it is the one publishing aired/DVD/absolute
    // orderings); TMDB is the stronger film source. Hence a per-kind default
    // rather than one global ranking.
    expect(resolveChain('tv', both)).toEqual(['tvdb', 'tmdb']);
    expect(resolveChain('anime', both)).toEqual(['tvdb', 'tmdb']);
    expect(resolveChain('movie', both)).toEqual(['tmdb', 'tvdb']);
    expect(DEFAULT_ORDER.tv[0]).toBe('tvdb');
  });

  it('drops providers that are not configured', () => {
    expect(resolveChain('tv', { tmdbApiKey: 'tm' })).toEqual(['tmdb']);
    expect(resolveChain('movie', { tvdbApiKey: 'tv' })).toEqual(['tvdb']);
  });

  it('is empty when nothing is configured — the caller then runs fully offline', () => {
    expect(resolveChain('tv', {})).toEqual([]);
    expect(resolveChain('movie', {})).toEqual([]);
  });

  it('honours an explicit order, still dropping the unconfigured', () => {
    expect(resolveChain('tv', { ...both, order: ['tmdb', 'tvdb'] })).toEqual(['tmdb', 'tvdb']);
    expect(resolveChain('tv', { tmdbApiKey: 'tm', order: ['tvdb', 'tmdb'] })).toEqual(['tmdb']);
    // An unknown name in the config can't conjure a provider.
    expect(resolveChain('tv', { ...both, order: ['nonsense', 'tvdb'] })).toEqual(['tvdb']);
  });
});

describe('MetadataProviderRegistry', () => {
  const settingsWith = (values: Record<string, unknown>) => ({
    get: jest.fn(async (key: string) => values[key]),
  });

  // config() falls back to the environment, so a key in the developer's shell
  // would otherwise decide the outcome of "nothing is configured".
  const env = { ...process.env };
  beforeEach(() => {
    delete process.env.TMDB_API_KEY;
    delete process.env.TVDB_API_KEY;
    delete process.env.TVDB_PIN;
  });
  afterAll(() => {
    process.env = env;
  });

  it('builds the chain from settings, in kind-aware order', async () => {
    const reg = new MetadataProviderRegistry(
      settingsWith({ 'media.tmdbApiKey': 'tm', 'media.tvdbApiKey': 'tv' }) as any,
    );

    expect((await reg.chain('tv')).map((p) => p.name)).toEqual(['tvdb', 'tmdb']);
    expect((await reg.chain('movie')).map((p) => p.name)).toEqual(['tmdb', 'tvdb']);
    expect(await reg.configured()).toEqual(['tvdb', 'tmdb']);
  });

  it('reuses the provider instance, so TVDB keeps its auth token across lookups', async () => {
    const reg = new MetadataProviderRegistry(settingsWith({ 'media.tvdbApiKey': 'tv' }) as any);

    const first = (await reg.chain('tv'))[0];
    const second = (await reg.chain('tv'))[0];

    expect(first).toBe(second); // same object — the token cache survives
  });

  it('builds a NEW instance when the key is rotated, rather than serving a dead token', async () => {
    const values: Record<string, unknown> = { 'media.tvdbApiKey': 'old-key' };
    const reg = new MetadataProviderRegistry(settingsWith(values) as any);

    const before = (await reg.chain('tv'))[0];
    values['media.tvdbApiKey'] = 'new-key';
    const after = (await reg.chain('tv'))[0];

    expect(after).not.toBe(before);
  });

  it('returns an empty chain and a usable offline provider when nothing is configured', async () => {
    const reg = new MetadataProviderRegistry(settingsWith({}) as any);

    expect(await reg.chain('tv')).toEqual([]);
    expect(await reg.configured()).toEqual([]);
    // The offline provider must still answer — this is what keeps the renamer
    // working with no keys at all, falling back to the parsed filename.
    await expect(reg.offline().fetchDetails({ kind: 'tv', title: 'X' })).resolves.toBeNull();
    expect(reg.offline().name).toBe('local');
  });

  it('does not hand out a provider that has no key', async () => {
    const reg = new MetadataProviderRegistry(settingsWith({ 'media.tmdbApiKey': 'tm' }) as any);

    expect(await reg.get('tvdb')).toBeNull();
    expect((await reg.get('tmdb'))?.name).toBe('tmdb');
  });
});
