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
      // Every known module is available; the seam exists so the rule lives in
      // one place, not because there is more than one answer.
      return byId.has(id);
    },
    async getStatus() { return { edition: 'community', valid: true, licensee: null, modules: [], issuedAt: null, expiresAt: null, expired: false }; },
    async getModuleLimits() { return {}; },
    async getGlobalLimits() { return {}; },
  };
}

function svcMissingLicense(manifests: ModuleManifest[], withheld: string[]) {
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const prisma = makePrisma();
  const base = tierLicense(byId);
  const s = new ModuleRegistryService(
    prisma,
    audit,
    { ...base, hasModule: async (id: string) => byId.has(id) && !withheld.includes(id) },
    );
  s.load(manifests);
  return { s, prisma };
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
  required: over.required ?? true, enabledByDefault: over.enabledByDefault ?? true,
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
    M({ id: 'auth', required: true }),
    M({ id: 'free', required: false, dependencies: ['auth'] }),
    M({ id: 'free_dep', required: false, dependencies: ['free'] }),
    M({ id: 'opt', required: false, enabledByDefault: false, dependencies: ['auth'] }),
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

/*
 * A disabled module has to say WHY it is disabled, and the three reasons are
 * not interchangeable.
 *
 * All three used to share one `else` reading "disabled by an administrator".
 * On a fresh install that sentence is false for every module shipping
 * `enabledByDefault: false` — it names an actor who never acted, and sends the
 * operator looking through the audit log for a change nobody made. Media
 * Discovery is deliberately off out of the box and reported itself as though
 * somebody had switched it off.
 */
describe('ModuleRegistryService — why a module is disabled', () => {
  const set = () => [
    M({ id: 'auth', required: true }),
    M({ id: 'free', required: false, dependencies: ['auth'] }),
    M({ id: 'opt', required: false, enabledByDefault: false, dependencies: ['auth'] }),
  ];

  it('does not blame an administrator for a module that is merely off by default', async () => {
    const { s, prisma } = svc(set());
    await s.refresh();
    // Nothing has ever been toggled: the override table is empty.
    expect([...prisma.states.values()]).toEqual([]);
    const opt = s.getStatus('opt')!;
    expect(opt.state).toBe('disabled');
    expect(opt.reason).not.toMatch(/administrator/);
    expect(opt.reason).toMatch(/off by default/);
  });

  it('does blame an administrator once one actually turns it off', async () => {
    const { s } = svc(set());
    await s.refresh();
    await s.disable('free');
    expect(s.getStatus('free')!.reason).toBe('disabled by an administrator');
  });

  /*
   * Re-enabling has to clear the accusation too. An override row exists either
   * way, so a reason keyed on the row's presence rather than its value would
   * leave "disabled by an administrator" on a module an administrator just
   * switched back on.
   */
  it('stops blaming an administrator after they turn it back on', async () => {
    const { s } = svc(set());
    await s.refresh();
    await s.disable('opt').catch(() => undefined);
    await s.enable('opt');
    expect(s.getStatus('opt')!.reason).toBe('active');
  });

  it('reports a withheld licence as a licence matter, not an administrator', async () => {
    const { s } = svcMissingLicense(set(), ['free']);
    await s.refresh();
    const free = s.getStatus('free')!;
    expect(free.licensed).toBe(false);
    expect(free.state).toBe('license_required');
    expect(free.reason).not.toMatch(/administrator/);
  });

  it('still names the unmet dependency rather than an administrator', async () => {
    const { s } = svc([
      M({ id: 'auth', required: true }),
      M({ id: 'base', required: false, enabledByDefault: false }),
      M({ id: 'needy', required: false, dependencies: ['base'] }),
    ]);
    await s.refresh();
    const needy = s.getStatus('needy')!;
    expect(needy.state).toBe('missing_dependency');
    expect(needy.reason).toContain('base');
  });
});
