/**
 * Which pipeline an RSS rule uses.
 *
 * The whole backward-compatibility promise is an asymmetry: a NEW rule defaults
 * to managed intake, while an EXISTING one is never moved unless somebody says
 * so explicitly. Getting this wrong in either direction is serious — one way
 * silently reroutes working rules on upgrade, the other quietly leaves the new
 * pipeline unused.
 */
import { RssService } from './rss.module';
import { DEFAULT_RSS_IMPORT_MODE, LEGACY_RSS_IMPORT_MODE } from '@ultratorrent/shared';

function build(existing: Record<string, unknown> | null = { id: 'r1', name: 'Old rule' }) {
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const prisma = {
    rssRule: {
      create: jest.fn(async (a: { data: Record<string, unknown> }) => {
        created.push(a.data);
        return { id: 'new', ...a.data };
      }),
      update: jest.fn(async (a: { data: Record<string, unknown> }) => {
        updated.push(a.data);
        return { id: 'r1', ...a.data };
      }),
      findUnique: jest.fn(async () => existing),
      findFirst: jest.fn(async () => null),
    },
  };
  // (prisma, registry, showStatus, audit, realtime, moduleRef)
  const svc = new RssService(
    prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never,
  );
  // The show-status lookup is not what this file is about.
  jest.spyOn(svc as never as { resolveShowStatusSnapshot: () => Promise<unknown> },
    'resolveShowStatusSnapshot').mockResolvedValue({} as never);
  return { svc, created, updated, prisma };
}

describe('a new rule', () => {
  it('defaults to managed intake', async () => {
    const { svc, created } = build();
    await svc.createRule({ feedId: 'f1', name: 'New rule' } as never);
    expect(created[0].importMode).toBe(DEFAULT_RSS_IMPORT_MODE);
    expect(created[0].importMode).toBe('managed_intake');
  });

  it('honours an explicit legacy choice', async () => {
    // An operator who wants the old behaviour for a new rule must be able to
    // say so; the default is a default, not a policy.
    const { svc, created } = build();
    await svc.createRule({ feedId: 'f1', name: 'New rule', importMode: 'legacy_direct' } as never);
    expect(created[0].importMode).toBe('legacy_direct');
  });

  it('carries the chosen storage profile', async () => {
    const { svc, created } = build();
    await svc.createRule({ feedId: 'f1', name: 'N', storageProfileId: 'p1' } as never);
    expect(created[0].storageProfileId).toBe('p1');
  });
});

describe('an existing rule', () => {
  it('is NOT migrated by an unrelated edit', async () => {
    /*
     * The load-bearing assertion of the whole feature. Renaming a rule, or
     * touching its regex, must not move it onto a different import pipeline as
     * a side effect. `undefined` means "leave it", and Prisma omits the column.
     */
    const { svc, updated } = build();
    await svc.updateRule('r1', { name: 'Renamed' } as never);
    expect(updated[0].importMode).toBeUndefined();
    expect(updated[0].storageProfileId).toBeUndefined();
  });

  it('changes only when the mode is sent explicitly', async () => {
    const { svc, updated } = build();
    await svc.updateRule('r1', { importMode: 'managed_intake' } as never);
    expect(updated[0].importMode).toBe('managed_intake');
  });

  it('can be moved back to legacy', async () => {
    // A migration that cannot be reversed is not one an operator will risk.
    const { svc, updated } = build();
    await svc.updateRule('r1', { importMode: LEGACY_RSS_IMPORT_MODE } as never);
    expect(updated[0].importMode).toBe('legacy_direct');
  });

  it('clears the profile when sent empty, rather than storing a blank', async () => {
    const { svc, updated } = build();
    await svc.updateRule('r1', { storageProfileId: '' } as never);
    expect(updated[0].storageProfileId).toBeNull();
  });
});
