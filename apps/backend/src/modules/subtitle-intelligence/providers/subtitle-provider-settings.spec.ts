import { REDACTED, SubtitleProviderSettingsService } from './subtitle-provider-settings.service';
import { SecretCipher } from '../../../common/crypto/secret-cipher';

/** In-memory fake of the Prisma delegate the settings service uses. */
function fakePrisma() {
  const rows = new Map<string, any>();
  return {
    rows,
    subtitleProviderConfig: {
      findUnique: async ({ where: { provider } }: any) => rows.get(provider) ?? null,
      findMany: async (args: any = {}) => {
        let out = [...rows.values()];
        if (args.where?.isEnabled !== undefined) out = out.filter((r) => r.isEnabled === args.where.isEnabled);
        if (args.orderBy) out = out.sort((a, b) => b.priority - a.priority); // priority desc
        return out;
      },
      upsert: async ({ where: { provider }, create, update }: any) => {
        const existing = rows.get(provider);
        const row = existing
          ? { ...existing, ...update }
          : {
              id: `id-${provider}`,
              provider,
              isEnabled: false,
              priority: 0,
              config: {},
              healthy: null,
              lastCheckedAt: null,
              lastError: null,
              quotaRemaining: null,
              quotaResetAt: null,
              ...create,
            };
        rows.set(provider, row);
        return row;
      },
      updateMany: async ({ where: { provider }, data }: any) => {
        const r = rows.get(provider);
        if (r) Object.assign(r, data);
        return { count: r ? 1 : 0 };
      },
    },
  };
}

describe('SubtitleProviderSettingsService (secret handling)', () => {
  const cipher = new SecretCipher({ get: () => 'unit-test-encryption-secret' } as any);
  const make = () => {
    const prisma = fakePrisma();
    return { prisma, svc: new SubtitleProviderSettingsService(prisma as any, cipher) };
  };

  it('encrypts secret keys at rest (never stores plaintext)', async () => {
    const { prisma, svc } = make();
    await svc.upsert('opensubtitles', { isEnabled: true, config: { apiKey: 'secret123', username: 'bob' } });
    const stored = prisma.rows.get('opensubtitles');
    expect(stored.config.apiKey).not.toBe('secret123');
    expect(stored.config.username).not.toBe('bob');
    // A non-secret field is stored as-is.
    await svc.upsert('local', { config: { repoPath: '/downloads/subs' } });
    expect(prisma.rows.get('local').config.repoPath).toBe('/downloads/subs');
  });

  it('redacts secrets in list() but keeps non-secret fields', async () => {
    const { svc } = make();
    await svc.upsert('opensubtitles', { config: { apiKey: 'secret123' } });
    await svc.upsert('local', { config: { repoPath: '/downloads/subs' } });
    const list = await svc.list();
    expect(list.find((p) => p.provider === 'opensubtitles')!.config.apiKey).toBe(REDACTED);
    expect(list.find((p) => p.provider === 'local')!.config.repoPath).toBe('/downloads/subs');
  });

  it('decrypts secrets for internal use via read()', async () => {
    const { svc } = make();
    await svc.upsert('opensubtitles', { config: { apiKey: 'secret123', username: 'bob' } });
    const dec = await svc.read('opensubtitles');
    expect(dec?.config.apiKey).toBe('secret123');
    expect(dec?.config.username).toBe('bob');
  });

  it('keeps the stored secret when a redacted placeholder is sent back', async () => {
    const { svc } = make();
    await svc.upsert('opensubtitles', { config: { apiKey: 'secret123' } });
    await svc.upsert('opensubtitles', { isEnabled: true, config: { apiKey: REDACTED } });
    expect((await svc.read('opensubtitles'))?.config.apiKey).toBe('secret123');
  });

  it('clears a secret when an empty value is sent', async () => {
    const { svc } = make();
    await svc.upsert('opensubtitles', { config: { apiKey: 'secret123' } });
    await svc.upsert('opensubtitles', { config: { apiKey: '' } });
    expect((await svc.read('opensubtitles'))?.config.apiKey).toBeUndefined();
  });

  it('readEnabled returns only enabled providers, decrypted, priority-ordered', async () => {
    const { svc } = make();
    await svc.upsert('opensubtitles', { isEnabled: true, priority: 5, config: { apiKey: 'k1' } });
    await svc.upsert('subdl', { isEnabled: false, config: { apiKey: 'k2' } });
    const enabled = await svc.readEnabled();
    expect(enabled.map((e) => e.provider)).toEqual(['opensubtitles']);
    expect(enabled[0].config.apiKey).toBe('k1');
  });
});
