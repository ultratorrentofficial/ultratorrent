import { ForbiddenException } from '@nestjs/common';
import { LicenseProvider, ModuleManifest } from '@ultratorrent/shared';
import { ModuleRegistryService } from './module-registry.service';

// --- mocks ---------------------------------------------------------------
function makePrisma() {
  const states = new Map<string, { moduleId: string; enabled: boolean }>();
  return {
    states,
    moduleState: {
      findMany: async () => [...states.values()],
      upsert: async ({ where, create, update }: any) => {
        const existing = states.get(where.moduleId);
        states.set(where.moduleId, { moduleId: where.moduleId, enabled: (existing ? update : create).enabled });
      },
    },
    moduleEvent: { create: async () => ({}) },
  } as any;
}
const audit = { record: async () => undefined } as any;

function tierLicense(byId: Map<string, ModuleManifest>): LicenseProvider {
  return {
    async hasModule(id: string) {
      const t = byId.get(id)?.tier;
      return t === 'core' || t === 'community';
    },
    async getStatus() { return { edition: 'community', valid: true, licensee: null, modules: [], issuedAt: null, expiresAt: null, expired: false }; },
    async getModuleLimits() { return {}; },
    async getGlobalLimits() { return {}; },
  };
}

function svc(manifests: ModuleManifest[]) {
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const prisma = makePrisma();
  const s = new ModuleRegistryService(prisma, audit, tierLicense(byId));
  s.load(manifests);
  return { s, prisma };
}

const M = (over: Partial<ModuleManifest>): ModuleManifest => ({
  id: over.id!, name: over.name ?? over.id!, description: '',
  tier: over.tier ?? 'core', enabledByDefault: over.enabledByDefault ?? true,
  dependencies: over.dependencies ?? [], permissions: over.permissions ?? [],
});

describe('ModuleRegistryService — validation', () => {
  it('rejects a dependency on an unknown module', () => {
    const { s } = svc([M({ id: 'a' })]);
    expect(() => s.load([M({ id: 'a', dependencies: ['ghost'] })])).toThrow(/unknown module/);
  });
  it('rejects circular dependencies', () => {
    const { s } = svc([M({ id: 'a' })]);
    expect(() =>
      s.load([M({ id: 'a', dependencies: ['b'] }), M({ id: 'b', dependencies: ['a'] })]),
    ).toThrow(/Circular/);
  });
  it('rejects an invalid manifest', () => {
    const { s } = svc([M({ id: 'a' })]);
    expect(() => s.load([{ id: 'x', tier: 'bogus' } as any])).toThrow(/Invalid manifest/);
  });
});

describe('ModuleRegistryService — states & rules', () => {
  const set = () => [
    M({ id: 'auth', tier: 'core' }),
    M({ id: 'free', tier: 'community', dependencies: ['auth'] }),
    M({ id: 'free_dep', tier: 'community', dependencies: ['free'] }),
    M({ id: 'opt', tier: 'community', enabledByDefault: false, dependencies: ['auth'] }),
  ];

  it('core is enabled and locked; community enabled by default', async () => {
    const { s } = svc(set());
    await s.refresh();
    expect(s.getStatus('auth')!.enabled).toBe(true);
    expect(s.getStatus('auth')!.locked).toBe(true);
    expect(s.getStatus('free')!.enabled).toBe(true);
  });

  it('an optional module off by default is available but not enabled', async () => {
    const { s } = svc(set());
    await s.refresh();
    const opt = s.getStatus('opt')!;
    expect(opt.licensed).toBe(true);
    expect(opt.enabled).toBe(false);
    expect(opt.state).toBe('disabled');
  });

  it('core modules cannot be disabled', async () => {
    const { s } = svc(set());
    await s.refresh();
    await expect(s.disable('auth')).rejects.toThrow(ForbiddenException);
  });

  it('an optional module off by default can be enabled', async () => {
    const { s } = svc(set());
    await s.refresh();
    await s.enable('opt');
    expect(s.getStatus('opt')!.enabled).toBe(true);
  });

  it('disabling a community module with an enabled dependent is refused', async () => {
    const { s } = svc(set());
    await s.refresh();
    await expect(s.disable('free')).rejects.toThrow(/dependents/i);
  });

  it('community module can be disabled then re-enabled', async () => {
    const { s } = svc(set());
    await s.refresh();
    await s.disable('free_dep'); // leaf first
    expect(s.getStatus('free_dep')!.enabled).toBe(false);
    await s.disable('free');
    expect(s.getStatus('free')!.enabled).toBe(false);
    await s.enable('free');
    expect(s.getStatus('free')!.enabled).toBe(true);
  });

  it('marks dependents missing_dependency when a dep is off', async () => {
    const { s } = svc(set());
    await s.refresh();
    await s.disable('free_dep');
    await s.disable('free');
    // free_dep wants enabled-by-default but its dep "free" is disabled.
    await s.enable('free_dep').catch(() => undefined); // refused (dep unmet) — stays computed
    const dep = s.getStatus('free_dep')!;
    expect(dep.enabled).toBe(false);
  });

  it('isEnabled reflects computed state', async () => {
    const { s } = svc(set());
    await s.refresh();
    expect(s.isEnabled('free')).toBe(true);
    expect(s.isEnabled('opt')).toBe(false);
  });
});
