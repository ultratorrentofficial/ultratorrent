/**
 * "Managed intake" on the Add Torrent dialog.
 *
 * Intake can only start from provenance, and a hand-added torrent has none —
 * which is why one saved into a library folder gets picked up by auto-organize
 * instead: the video is renamed out from under the torrent, the torrent dropped
 * because it can no longer seed, and the release's subtitles left behind in the
 * old folder. This mode records the operator's decision at the only moment it
 * can be recorded, and takes the save path out of their hands so the download
 * cannot land somewhere that undoes it.
 */
import { BadRequestException } from '@nestjs/common';
import { TorrentsService } from './torrents.service';

function build(opts: {
  profile?: { id: string; name: string; stagingRoot: string; isEnabled: boolean } | null;
  upsertFails?: boolean;
} = {}) {
  const added: Array<{ magnet?: string; options?: Record<string, unknown> }> = [];
  const upserts: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];

  const provider = {
    engineId: 'engine-1',
    addMagnet: jest.fn(async (magnet: string, options: Record<string, unknown>) => {
      added.push({ magnet, options });
      return 'HASH-1';
    }),
  };
  const registry = { resolve: jest.fn(async () => provider) };
  const audit = { record: jest.fn(async (e: Record<string, unknown>) => { audits.push(e); }) };
  // The hard-root guard. Returning the input unchanged keeps the assertion about
  // WHICH path was checked, not about what the guard does with it.
  const filePath = { assertWithinHardRoots: jest.fn((p: string) => p) };
  const prisma = {
    storageProfile: {
      findUnique: jest.fn(async () =>
        opts.profile === undefined
          ? { id: 'p1', name: 'Movies', stagingRoot: '/downloads/Intake/Movies', isEnabled: true }
          : opts.profile),
    },
    intakeIntent: {
      upsert: jest.fn(async (args: Record<string, unknown>) => {
        if (opts.upsertFails) throw new Error('db is down');
        upserts.push(args);
        return args;
      }),
    },
  };

  const svc = new TorrentsService(
    registry as never, audit as never, filePath as never, prisma as never,
    {} as never, {} as never, { annotate: async (ts: unknown[]) => ts } as never,
  );
  const logger = (svc as never as { logger: Record<string, (m: string) => void> }).logger;
  const errors: string[] = [];
  jest.spyOn(logger, 'error').mockImplementation((m: string) => { errors.push(m); });

  // A real 40-hex info-hash: `add` validates the magnet before it reaches any of
  // the behaviour under test, so a placeholder would fail every case at line one.
  const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';

  const add = (over: Record<string, unknown> = {}) =>
    svc.add(
      { magnet: MAGNET, intakeProfileId: 'p1', ...over } as never,
      undefined,
      { id: 'u1' } as never,
      {},
    );

  return { svc, add, added, upserts, audits, prisma, filePath, provider, errors };
}

describe('adding a torrent for managed intake', () => {
  it('stages under the profile root, overriding whatever save path was sent', async () => {
    /*
     * The whole point of the mode. Honouring a caller-supplied path here would
     * let an intake add land inside a library — the exact arrangement that
     * strands a release's subtitles and kills its seed.
     */
    const { add, added } = build();
    await add({ savePath: '/downloads/Movies/HD Movies/Some Film (2009)' });
    expect(added[0].options).toMatchObject({ savePath: '/downloads/Intake/Movies' });
  });

  it('checks the staging root against the hard roots like any other path', async () => {
    // Ours is not a synonym for safe: the profile root is operator-editable.
    const { add, filePath } = build();
    await add();
    expect(filePath.assertWithinHardRoots).toHaveBeenCalledWith('/downloads/Intake/Movies');
  });

  it('records the intent against the hash the engine returned', async () => {
    const { add, upserts } = build();
    await add();
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      where: { engineId_hash: { engineId: 'engine-1', hash: 'HASH-1' } },
      create: { engineId: 'engine-1', hash: 'HASH-1', profileId: 'p1', createdById: 'u1' },
    });
  });

  it('reopens a spent intent when the same torrent is added again', async () => {
    // Re-adding is ordinary. A consumed row would leave the re-add unimported,
    // and a bare create would 500 on the primary key.
    const { add, upserts } = build();
    await add();
    expect(upserts[0]).toMatchObject({ update: { consumedAt: null, profileId: 'p1' } });
  });

  it('refuses a disabled profile instead of adding something nothing will import', async () => {
    /*
     * "Enabled but inert" again: accepting the add would look successful, the
     * download would finish, and no intake would ever run — with nothing
     * anywhere to say why.
     */
    const { add, added } = build({
      profile: { id: 'p1', name: 'Movies', stagingRoot: '/downloads/Intake/Movies', isEnabled: false },
    });
    await expect(add()).rejects.toBeInstanceOf(BadRequestException);
    expect(added).toHaveLength(0);
  });

  it('refuses a profile that no longer exists', async () => {
    const { add, added } = build({ profile: null });
    await expect(add()).rejects.toBeInstanceOf(BadRequestException);
    expect(added).toHaveLength(0);
  });

  it('does not fail the add when the intent cannot be written', async () => {
    /*
     * The torrent is already in the engine by then. Throwing would report a
     * failed add for something that succeeded, and the operator would add it
     * twice.
     */
    const { add, errors } = build({ upsertFails: true });
    await expect(add()).resolves.toMatchObject({ hash: 'HASH-1' });
    expect(errors.join(' ')).toMatch(/intake intent could not be recorded/);
  });

  it('leaves an ordinary add completely alone', async () => {
    // The regression that matters most: no intent, no path rewriting, no
    // profile lookup for anyone who never asked for intake.
    const { add, added, upserts, prisma } = build();
    await add({ intakeProfileId: undefined, savePath: '/downloads/Movies' });
    expect(upserts).toHaveLength(0);
    expect(prisma.storageProfile.findUnique).not.toHaveBeenCalled();
    expect(added[0].options).toMatchObject({ savePath: '/downloads/Movies' });
  });

  it('records the chosen profile on the audit row', async () => {
    // The add is where the decision was made; the audit trail is where an
    // operator looks when an import surprises them later.
    const { add, audits } = build();
    await add();
    expect(audits[0]).toMatchObject({
      action: 'torrents.add',
      objectId: 'HASH-1',
      metadata: { intakeProfileId: 'p1', savePath: '/downloads/Intake/Movies' },
    });
  });
});
