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

function build(
  existing: Record<string, unknown> | null = { id: 'r1', name: 'Old rule' },
  /** The profile a managed rule resolves; null models "none configured". */
  profile: Record<string, unknown> | null = null,
) {
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
  const storageProfiles = {
    get: jest.fn(async () => profile),
    defaultProfile: jest.fn(async () => profile),
  };
  // (prisma, registry, showStatus, audit, realtime, moduleRef, storageProfiles)
  const svc = new RssService(
    prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    storageProfiles as never,
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

describe('a managed rule must not download into its own destination library', () => {
  /*
   * Managed intake places files INTO the library from wherever the torrent
   * landed. If the torrent already landed there, the placement is
   * library-to-library and the library gains the raw release filename AND the
   * renamed hardlink, both scanned — a duplicate of everything it imports.
   *
   * Trivially reachable: importMode and savePath are independent fields, and
   * EVERY rule predating Media Intake points at a library, because that is what
   * legacy direct import means. On a live install all 163 rules did.
   */
  const profile = {
    name: 'Synoplex', stagingRoot: '/downloads/Intake',
    tvLibrary: { name: 'TV Shows', path: '/downloads/TV Shows' },
    movieLibrary: null, musicLibrary: null,
  };

  it('REFUSES the conversion that would duplicate the library', async () => {
    const { svc } = build({ id: 'r1', name: 'Old rule', savePath: '/downloads/TV Shows/9-1-1 (2018)', importMode: 'legacy_direct', storageProfileId: null }, profile);
    await expect(svc.updateRule('r1', { importMode: 'managed_intake' } as never))
      .rejects.toThrow(/would import from that library back into itself/);
  });

  it('names the staging root, so the fix is one paste away', async () => {
    const { svc } = build({ id: 'r1', name: 'Old rule', savePath: '/downloads/TV Shows/9-1-1 (2018)', importMode: 'legacy_direct', storageProfileId: null }, profile);
    await expect(svc.updateRule('r1', { importMode: 'managed_intake' } as never))
      .rejects.toThrow(/\/downloads\/Intake/);
  });

  it('allows a managed rule that stages properly', async () => {
    const { svc, updated } = build({ id: 'r1', name: 'Old rule', savePath: '/downloads/TV Shows/9-1-1 (2018)', importMode: 'legacy_direct', storageProfileId: null }, profile);
    await svc.updateRule('r1', { importMode: 'managed_intake', savePath: '/downloads/Intake/9-1-1' } as never);
    expect(updated[0].importMode).toBe('managed_intake');
  });

  it('judges the RESULTING rule, not the patch', async () => {
    // Changing only the savePath of an ALREADY managed rule, to an in-library
    // path, is the same corruption arrived at from the other direction.
    const { svc } = build({ id: 'r1', name: 'Old rule', savePath: '/downloads/Intake/x', importMode: 'managed_intake', storageProfileId: null }, profile);
    await expect(svc.updateRule('r1', { savePath: '/downloads/TV Shows/9-1-1 (2018)' } as never))
      .rejects.toThrow(/back into itself/);
  });

  it('leaves LEGACY rules completely alone', async () => {
    // The backward-compatibility promise: an in-library save path is exactly what
    // legacy direct import is FOR, and must never be refused.
    const { svc, updated } = build({ id: 'r1', name: 'Old rule', savePath: '/downloads/TV Shows/9-1-1 (2018)', importMode: 'legacy_direct', storageProfileId: null }, profile);
    await svc.updateRule('r1', { name: 'Renamed' } as never);
    expect(updated[0].name).toBe('Renamed');
  });

  it('does not block a managed rule when no profile is configured', async () => {
    // Nothing to compare against; the dialog and the trigger both already say a
    // managed rule without a profile imports nothing.
    const { svc, updated } = build({ id: 'r1', name: 'Old rule', savePath: '/downloads/TV Shows/9-1-1 (2018)', importMode: 'legacy_direct', storageProfileId: null }, null);
    await svc.updateRule('r1', { importMode: 'managed_intake' } as never);
    expect(updated[0].importMode).toBe('managed_intake');
  });

  it('refuses a NEW managed rule pointed at a library too', async () => {
    const { svc } = build(null, profile);
    await expect(svc.createRule({ feedId: 'f1', name: 'New', savePath: '/downloads/TV Shows/New Show' } as never))
      .rejects.toThrow(/back into itself/);
  });

  it('compares segment-wise, so a sibling directory is fine', async () => {
    // "/downloads/TV Shows Staging" is not inside "/downloads/TV Shows".
    const { svc, updated } = build({ id: 'r1', name: 'Old rule', savePath: '/downloads/TV Shows Staging/x', importMode: 'legacy_direct', storageProfileId: null }, profile);
    await svc.updateRule('r1', { importMode: 'managed_intake' } as never);
    expect(updated[0].importMode).toBe('managed_intake');
  });
});
