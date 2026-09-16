import { LifecyclePolicyService } from './lifecycle-policy.service';

/**
 * Operator intent: storage and validation.
 *
 * The claims worth pinning are the ones that protect the three-valued
 * contract the resolver depends on, and the ones that keep this service from
 * quietly accepting a configuration the operator cannot reason about.
 */

type Row = Record<string, unknown>;

function stub(existing: Row | null = null) {
  const calls = { created: [] as Row[], updated: [] as Row[], deleted: [] as Row[], audits: [] as Row[] };
  const prisma = {
    mediaLifecyclePolicy: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => existing),
      create: jest.fn(async (args: { data: Row }) => {
        calls.created.push(args.data);
        return { id: 'p1', createdAt: new Date(), updatedAt: new Date(), ...args.data };
      }),
      update: jest.fn(async (args: { data: Row }) => {
        calls.updated.push(args.data);
        return { id: 'p1', createdAt: new Date(), updatedAt: new Date(), ...existing, ...args.data };
      }),
      delete: jest.fn(async (args: Row) => {
        calls.deleted.push(args);
        return {};
      }),
    },
  };
  const audit = {
    record: jest.fn(async (e: Row) => {
      calls.audits.push(e);
    }),
  };
  return { svc: new LifecyclePolicyService(prisma as never, audit as never), prisma, calls };
}

const valid = { name: 'Global Standard', quality: 'maintain_preferred' as const };

describe('LifecyclePolicyService.create — validation', () => {
  it('refuses a policy that expresses no intent at all', async () => {
    const { svc } = stub();
    // It would sit in the list looking active while contributing nothing.
    await expect(svc.create({ name: 'Empty' } as never)).rejects.toThrow(/at least one thing/i);
  });

  it('refuses a nameless policy', async () => {
    const { svc } = stub();
    await expect(svc.create({ name: '   ', quality: 'maintain_preferred' } as never)).rejects.toThrow(/needs a name/i);
  });

  it('refuses a global policy that also names a scope id', async () => {
    const { svc } = stub();
    // "Global, but only for this library" is a contradiction. Silently
    // dropping the id would leave the operator believing it was honoured.
    await expect(
      svc.create({ ...valid, scopeType: 'global', scopeId: 'lib-1' } as never),
    ).rejects.toThrow(/cannot name a scope id/i);
  });

  it('refuses a scoped policy that names nothing', async () => {
    const { svc } = stub();
    await expect(svc.create({ ...valid, scopeType: 'library' } as never)).rejects.toThrow(/must name what it applies to/i);
  });

  it('refuses `automatic`, which Phase 5 cannot honour', async () => {
    const { svc } = stub();
    // There is no executor. A mode implying one is refused outright rather
    // than silently downgraded to advisory.
    await expect(svc.create({ ...valid, mode: 'automatic' } as never)).rejects.toThrow(/Unknown mode/i);
  });

  it('refuses an unknown quality intent', async () => {
    const { svc } = stub();
    await expect(svc.create({ name: 'x', quality: 'maintain_perfect' } as never)).rejects.toThrow(/Unknown quality/i);
  });
});

describe('LifecyclePolicyService.create — the three-valued contract', () => {
  it('stores an unmentioned dimension as NULL, so it inherits', async () => {
    const { svc, calls } = stub();
    await svc.create({ ...valid } as never);
    expect(calls.created[0].completeness).toBeNull();
    // `undefined` leaves the column unset rather than writing an empty list.
    expect(calls.created[0].subtitleLanguages).toBeUndefined();
  });

  it('preserves an EMPTY language list as an explicit decision', async () => {
    const { svc, calls } = stub();
    await svc.create({ name: 'No subs', subtitleLanguages: [] } as never);
    // [] means "explicitly none" and must stop inheritance. Folding it into
    // null would turn it back into "inherit", which is the opposite.
    expect(calls.created[0].subtitleLanguages).toEqual([]);
  });

  it('stores `do_not_manage` as a value, not as an absence', async () => {
    const { svc, calls } = stub();
    await svc.create({ name: 'Hands off', quality: 'do_not_manage' } as never);
    expect(calls.created[0].quality).toBe('do_not_manage');
  });

  it('normalizes and de-duplicates languages without losing order intent', async () => {
    const { svc, calls } = stub();
    await svc.create({ name: 'Subs', subtitleLanguages: [' EN ', 'es', 'en'] } as never);
    expect(calls.created[0].subtitleLanguages).toEqual(['en', 'es']);
  });
});

describe('LifecyclePolicyService.update', () => {
  const stored = {
    id: 'p1', name: 'Existing', description: null, enabled: true,
    scopeType: 'library', scopeId: 'lib-1', mode: 'recommend_only',
    quality: 'maintain_preferred', completeness: null,
    subtitleLanguages: null, acquisition: null,
    createdBy: null, createdAt: new Date(), updatedAt: new Date(),
  };

  it('validates the RESULTING policy, not just the patch', async () => {
    const { svc } = stub(stored);
    // Switching to global without clearing the scope id is the broken pair;
    // validating only the patch would let it through.
    await expect(svc.update('p1', { scopeType: 'global', scopeId: 'lib-1' } as never)).rejects.toThrow(
      /cannot name a scope id/i,
    );
  });

  it('leaves untouched dimensions exactly as they were', async () => {
    const { svc, calls } = stub(stored);
    await svc.update('p1', { name: 'Renamed' } as never);
    expect(calls.updated[0].quality).toBe('maintain_preferred');
    expect(calls.updated[0].scopeId).toBe('lib-1');
  });

  it('records enabling and disabling under their own audit verbs', async () => {
    const { svc, calls } = stub(stored);
    await svc.update('p1', { enabled: false } as never);
    expect(calls.audits[0].action).toBe('media_intelligence.lifecycle_policy.disabled');
  });

  it('records an ordinary edit as an update', async () => {
    const { svc, calls } = stub(stored);
    await svc.update('p1', { name: 'Renamed' } as never);
    expect(calls.audits[0].action).toBe('media_intelligence.lifecycle_policy.updated');
  });
});

describe('LifecyclePolicyService.remove', () => {
  const stored = {
    id: 'p1', name: 'Doomed', description: null, enabled: true,
    scopeType: 'global', scopeId: null, mode: 'recommend_only',
    quality: 'maintain_preferred', completeness: null,
    subtitleLanguages: null, acquisition: null,
    createdBy: null, createdAt: new Date(), updatedAt: new Date(),
  };

  it('deletes the policy and touches nothing else', async () => {
    const { svc, prisma, calls } = stub(stored);
    await svc.remove('p1');

    expect(calls.deleted).toEqual([{ where: { id: 'p1' } }]);
    // Removing intent must not reach into media, findings or recommendations.
    expect(Object.keys(prisma)).toEqual(['mediaLifecyclePolicy']);
  });

  it('audits the removal with the intent that was lost', async () => {
    const { svc, calls } = stub(stored);
    await svc.remove('p1', 'user-1');
    expect(calls.audits[0]).toMatchObject({
      action: 'media_intelligence.lifecycle_policy.deleted',
      objectType: 'media_lifecycle_policy',
      objectId: 'p1',
    });
  });
});

describe('LifecyclePolicyService — audit hygiene', () => {
  it('records what intent was expressed, never the media it will touch', async () => {
    const { svc, calls } = stub();
    await svc.create({ ...valid, scopeType: 'library', scopeId: 'lib-1' } as never, 'user-1');

    const meta = calls.audits[0].metadata as Record<string, unknown>;
    expect(meta.dimensions).toEqual(['quality']);
    expect(meta.scopeType).toBe('library');
    // No titles, no paths, no counts of affected files.
    expect(JSON.stringify(meta)).not.toMatch(/path|title|\/mnt|\/downloads/i);
  });
});
