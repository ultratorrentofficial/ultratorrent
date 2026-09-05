import { DiscoveryProviderRegistry } from './discovery-provider-registry.service';
import type { DiscoveryCapability } from '@ultratorrent/shared';
import type { ReleaseDiscoveryProvider } from './discovery-provider';

function provider(
  name: string,
  caps: DiscoveryCapability[],
  health: () => Promise<any> = async () => ({ healthy: true }),
): ReleaseDiscoveryProvider {
  return { name, capabilities: () => caps, healthCheck: health };
}

describe('DiscoveryProviderRegistry — routing by capability', () => {
  let reg: DiscoveryProviderRegistry;
  beforeEach(() => {
    reg = new DiscoveryProviderRegistry();
  });

  /*
   * The deliberate difference from the metadata registry: that one builds a
   * CHAIN and stops at the first answer, because a file has one identity.
   * Discovery wants every provider that can answer, because the whole point is
   * to surface a title one provider has and another does not.
   */
  it('returns EVERY provider supporting a capability, not just the first', () => {
    reg.register(provider('tmdb', ['upcoming_movies', 'trending']));
    reg.register(provider('tvmaze', ['upcoming_movies', 'upcoming_episodes']));

    expect(reg.supporting('upcoming_movies').map((p) => p.name)).toEqual(['tmdb', 'tvmaze']);
  });

  it('never offers a provider a question it did not claim to answer', () => {
    reg.register(provider('tmdb', ['upcoming_movies']));
    expect(reg.supporting('upcoming_episodes')).toEqual([]);
  });

  it('narrows to the providers a template selected', () => {
    reg.register(provider('tmdb', ['upcoming_movies']));
    reg.register(provider('tvmaze', ['upcoming_movies']));

    expect(reg.supporting('upcoming_movies', ['tvmaze']).map((p) => p.name)).toEqual(['tvmaze']);
  });

  /*
   * A provider can be removed or left unconfigured. Every template that once
   * named it must keep working — silence from that provider, not an error.
   */
  it('is silent about a selected provider that is not registered', () => {
    reg.register(provider('tmdb', ['upcoming_movies']));
    expect(reg.supporting('upcoming_movies', ['trakt'])).toEqual([]);
  });

  it('re-registering a provider replaces it rather than duplicating it', () => {
    reg.register(provider('tmdb', ['upcoming_movies']));
    reg.register(provider('tmdb', ['trending']));

    expect(reg.all()).toHaveLength(1);
    expect(reg.supporting('upcoming_movies')).toEqual([]);
    expect(reg.supporting('trending').map((p) => p.name)).toEqual(['tmdb']);
  });
});

describe('DiscoveryProviderRegistry — health', () => {
  it('reports each provider', async () => {
    const reg = new DiscoveryProviderRegistry();
    reg.register(provider('tmdb', [], async () => ({ healthy: true, responseMs: 42 })));
    reg.register(provider('tvmaze', [], async () => ({ healthy: false, message: 'timeout' })));

    expect(await reg.health()).toEqual({
      tmdb: { healthy: true, responseMs: 42 },
      tvmaze: { healthy: false, message: 'timeout' },
    });
  });

  /*
   * The one screen an operator opens to find out which provider is broken must
   * not itself break because a provider is broken.
   */
  it('reports a provider whose own health check throws, and still reports the others', async () => {
    const reg = new DiscoveryProviderRegistry();
    reg.register(provider('broken', [], async () => { throw new Error('ECONNREFUSED'); }));
    reg.register(provider('fine', [], async () => ({ healthy: true })));

    const health = await reg.health();
    expect(health.broken.healthy).toBe(false);
    expect(health.fine.healthy).toBe(true);
    // The raw error is logged, never surfaced — it can carry a URL with a key in it.
    expect(JSON.stringify(health)).not.toContain('ECONNREFUSED');
  });
});
