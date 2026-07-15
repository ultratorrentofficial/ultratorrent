import { SubtitleProviderRegistry, PROVIDER_CATALOG } from './provider-registry.service';
import type { DecryptedProviderConfig } from './subtitle-provider-settings.service';

const cfg = (over: Partial<DecryptedProviderConfig>): DecryptedProviderConfig => ({
  provider: 'opensubtitles',
  isEnabled: true,
  priority: 0,
  config: { apiKey: 'k' },
  healthy: null,
  lastCheckedAt: null,
  lastError: null,
  quotaRemaining: null,
  quotaResetAt: null,
  ...over,
});

const fakeGuard = { assertWithinHardRoots: (p: string) => p };

function registryWith(enabled: DecryptedProviderConfig[]) {
  const settings = {
    readEnabled: async () => enabled,
    read: async (p: string) => enabled.find((e) => e.provider === p) ?? null,
  };
  return new SubtitleProviderRegistry(settings as never, fakeGuard as never);
}

describe('SubtitleProviderRegistry', () => {
  it('builds a configured OpenSubtitles provider', async () => {
    const providers = await registryWith([cfg({})]).build();
    expect(providers.map((p) => p.name)).toEqual(['opensubtitles']);
  });

  it('drops an enabled provider that is not validly configured', async () => {
    const providers = await registryWith([cfg({ config: {} })]).build(); // no apiKey
    expect(providers).toHaveLength(0);
  });

  it('builds SubDL and Local providers', async () => {
    const subdl = await registryWith([cfg({ provider: 'subdl', config: { apiKey: 'k' } })]).build();
    expect(subdl.map((p) => p.name)).toEqual(['subdl']);
    const local = await registryWith([cfg({ provider: 'local', config: { repoPath: '/downloads/subs' } })]).build();
    expect(local.map((p) => p.name)).toEqual(['local']);
  });

  it('builds the keyless YIFY / SubtitleCat / Podnapisi providers', async () => {
    for (const provider of ['yify', 'subtitlecat', 'podnapisi']) {
      const built = await registryWith([cfg({ provider, config: {} })]).build();
      expect(built.map((p) => p.name)).toEqual([provider]);
    }
  });

  it('ignores providers that have no concrete implementation yet', async () => {
    const providers = await registryWith([cfg({ provider: 'addic7ed', config: { username: 'u', password: 'p' } })]).build();
    expect(providers).toHaveLength(0);
  });

  it('resolves a single provider by key', async () => {
    const p = await registryWith([cfg({})]).get('opensubtitles');
    expect(p?.name).toBe('opensubtitles');
    expect(await registryWith([cfg({})]).get('addic7ed')).toBeNull();
  });
});

describe('PROVIDER_CATALOG', () => {
  it('marks the six shipped providers implemented and the rest as prepared', () => {
    const os = PROVIDER_CATALOG.find((c) => c.key === 'opensubtitles');
    expect(os?.implemented).toBe(true);
    expect(os?.secretFields).toContain('apiKey');
    for (const key of ['subdl', 'local', 'podnapisi', 'yify', 'subtitlecat']) {
      expect(PROVIDER_CATALOG.find((c) => c.key === key)?.implemented).toBe(true);
    }
    for (const key of ['addic7ed', 'subs4free']) {
      expect(PROVIDER_CATALOG.find((c) => c.key === key)?.implemented).toBe(false);
    }
  });
});
