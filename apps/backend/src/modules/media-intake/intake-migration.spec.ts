import { IntakeMigrationService } from './intake-migration.service';

/**
 * Bulk conversion to managed intake.
 *
 * Converting a rule is two coordinated edits — repoint `savePath` at staging and
 * set `importMode` — and half of that pair is the corruption the rule service
 * refuses one at a time: a managed rule still downloading into its destination
 * library imports that library into itself. So the risk here is not "does it
 * convert", it is "does it ever write half a pair, or convert something nobody
 * chose".
 */

const PROFILE = {
  id: 'p1',
  name: 'Synoplex',
  stagingRoot: '/downloads/Intake',
  tvLibrary: { name: 'TV Shows', path: '/downloads/TV Shows' },
  movieLibrary: null,
  musicLibrary: null,
};

function build(over: {
  rules?: Array<Record<string, unknown>>;
  profile?: Record<string, unknown> | null;
} = {}) {
  const rules = over.rules ?? [
    { id: 'r1', name: '9-1-1', savePath: '/downloads/TV Shows/9-1-1 (2018)', importMode: 'legacy_direct', storageProfileId: null, preMigrationSavePath: null },
  ];
  const writes: Array<{ id: string; data: Record<string, unknown> }> = [];
  const prisma = {
    rssRule: {
      findMany: jest.fn(async (args: any) => {
        const ids = args?.where?.id?.in;
        return ids ? rules.filter((r) => ids.includes(r.id)) : rules;
      }),
      update: jest.fn((a: any) => {
        writes.push({ id: a.where.id, data: a.data });
        const row = rules.find((r) => r.id === a.where.id);
        if (row) Object.assign(row, a.data);
        return a;
      }),
    },
    // The real client defers; the mock just runs what it was handed.
    $transaction: jest.fn(async (ops: unknown[]) => ops),
  };
  const profile = over.profile === undefined ? PROFILE : over.profile;
  const profiles = {
    get: jest.fn(async () => profile),
    defaultProfile: jest.fn(async () => profile),
  };
  const svc = new IntakeMigrationService(prisma as never, profiles as never);
  return { svc, prisma, writes, rules };
}

describe('IntakeMigrationService.preview', () => {
  it('proposes a staging path that keeps the show’s own folder', async () => {
    // Flattening every show into one staging root would collide: intake keys a
    // job by its source path, so two shows finishing at once fight over it.
    const [p] = await build().svc.preview();
    expect(p.verdict).toBe('convertible');
    expect(p.proposedSavePath).toBe('/downloads/Intake/9-1-1 (2018)');
  });

  it('falls back to the rule name when the rule has no save path', async () => {
    const { svc } = build({ rules: [{ id: 'r1', name: 'Ghosts', savePath: null, importMode: 'legacy_direct', storageProfileId: null }] });
    const [p] = await svc.preview();
    expect(p.proposedSavePath).toBe('/downloads/Intake/Ghosts');
  });

  it('lists an already-managed rule rather than hiding it', async () => {
    // A preview that silently drops rows turns "why is this blocked" into the
    // worse question "why is this missing".
    const { svc } = build({ rules: [{ id: 'r1', name: 'Done', savePath: '/x', importMode: 'managed_intake', storageProfileId: 'p1' }] });
    const [p] = await svc.preview();
    expect(p.verdict).toBe('already_managed');
  });

  it('blocks when no profile resolves, and says why', async () => {
    const { svc } = build({ profile: null });
    const [p] = await svc.preview();
    expect(p.verdict).toBe('no_profile');
    expect(p.reason).toMatch(/nowhere to stage/);
  });

  it('blocks when the staging path would land inside a library', async () => {
    /*
     * The profile validates this when saved, but a profile edited since could
     * have drifted — and converting into it would import a library into itself
     * for every selected rule at once.
     */
    const { svc } = build({
      profile: { ...PROFILE, stagingRoot: '/downloads/TV Shows/Staging' },
    });
    const [p] = await svc.preview();
    expect(p.verdict).toBe('staging_conflict');
    expect(p.reason).toMatch(/inside the "TV Shows" library/);
  });

  it('writes nothing', async () => {
    const { svc, writes } = build();
    await svc.preview();
    expect(writes).toHaveLength(0);
  });
});

describe('IntakeMigrationService.apply', () => {
  it('converts BOTH fields together', async () => {
    // Half a pair is the corruption; the mode alone would leave the rule
    // importing its own library.
    const { svc, writes } = build();
    await svc.apply(['r1']);
    expect(writes[0].data).toMatchObject({
      savePath: '/downloads/Intake/9-1-1 (2018)',
      importMode: 'managed_intake',
    });
  });

  it('records the previous save path BEFORE overwriting it', async () => {
    // Without this a revert cannot put the rule back, and it downloads into
    // staging forever.
    const { svc, writes } = build();
    await svc.apply(['r1']);
    expect(writes[0].data.preMigrationSavePath).toBe('/downloads/TV Shows/9-1-1 (2018)');
  });

  it('touches only the rules it was given', async () => {
    const { svc, writes } = build({
      rules: [
        { id: 'r1', name: 'A', savePath: '/downloads/TV Shows/A', importMode: 'legacy_direct', storageProfileId: null },
        { id: 'r2', name: 'B', savePath: '/downloads/TV Shows/B', importMode: 'legacy_direct', storageProfileId: null },
      ],
    });
    await svc.apply(['r1']);
    expect(writes.map((w) => w.id)).toEqual(['r1']);
  });

  it('RE-PREVIEWS instead of trusting the ids', async () => {
    /*
     * The operator's selection was computed against a snapshot. If the profile
     * has since gone, converting anyway writes a managed rule with nowhere to
     * stage — so the verdict is recomputed at apply time and the rule is skipped.
     */
    const { svc, writes } = build({ profile: null });
    const res = await svc.apply(['r1']);
    expect(writes).toHaveLength(0);
    expect(res.converted).toBe(0);
    expect(res.skipped[0].verdict).toBe('no_profile');
  });

  it('refuses an empty selection rather than converting everything', async () => {
    await expect(build().svc.apply([])).rejects.toThrow(/No rules were selected/);
  });

  it('reports what it skipped, not just what it did', async () => {
    const { svc } = build({ rules: [{ id: 'r1', name: 'Done', savePath: '/x', importMode: 'managed_intake', storageProfileId: 'p1' }] });
    const res = await svc.apply(['r1']);
    expect(res.converted).toBe(0);
    expect(res.skipped).toHaveLength(1);
  });
});

describe('IntakeMigrationService.revert', () => {
  it('restores the save path as well as the mode', async () => {
    /*
     * The whole reason the column exists. A revert that only flipped the mode
     * would leave the rule on legacy_direct still downloading into staging —
     * where nothing imports from — stranding every future episode. That is worse
     * than the state being escaped.
     */
    const { svc, writes } = build({
      rules: [{ id: 'r1', name: '9-1-1', savePath: '/downloads/Intake/9-1-1 (2018)', importMode: 'managed_intake', preMigrationSavePath: '/downloads/TV Shows/9-1-1 (2018)' }],
    });
    await svc.revert(['r1']);
    expect(writes[0].data).toMatchObject({
      savePath: '/downloads/TV Shows/9-1-1 (2018)',
      importMode: 'legacy_direct',
    });
  });

  it('clears the record, so a second revert cannot undo an unrelated edit', async () => {
    const { svc, writes } = build({
      rules: [{ id: 'r1', name: '9-1-1', savePath: '/downloads/Intake/x', importMode: 'managed_intake', preMigrationSavePath: '/downloads/TV Shows/x' }],
    });
    await svc.revert(['r1']);
    expect(writes[0].data.preMigrationSavePath).toBeNull();
  });

  it('SKIPS a rule the wizard never converted', async () => {
    // No recorded path to restore, and inventing one would point the rule
    // somewhere it has never downloaded.
    const { svc, writes } = build({
      rules: [{ id: 'r1', name: 'Hand-made', savePath: '/downloads/Intake/x', importMode: 'managed_intake', preMigrationSavePath: null }],
    });
    const res = await svc.revert(['r1']);
    expect(writes).toHaveLength(0);
    expect(res.reverted).toBe(0);
    expect(res.skipped).toEqual(['Hand-made']);
  });

  it('refuses an empty selection', async () => {
    await expect(build().svc.revert([])).rejects.toThrow(/No rules were selected/);
  });
});
