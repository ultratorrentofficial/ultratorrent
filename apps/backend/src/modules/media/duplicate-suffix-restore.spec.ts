import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DuplicateResolutionService } from './duplicate-resolution.service';

/**
 * Giving back a canonical name that nothing else holds.
 *
 * `[dupN]` means "something else holds the real name". Media Intake writes it
 * when a new release claims a taken name, and resolving the resulting duplicate
 * group hands the survivor its name back. An import that FAILS partway leaves
 * the suffix with no second copy — so no group forms, the restoration inside
 * `resolve` never runs, and the library keeps a file named after a conflict
 * that does not exist. Live on synoplex: five films, three of them from intake
 * jobs that died at the metadata stage.
 *
 * The line these tests hold: restore only when the canonical name is FREE. A
 * `[dupN]` file whose twin still exists is a real duplicate and belongs to the
 * operator, not to a sweep.
 */
function build(root: string, items: Array<{ id: string; path: string; locked?: boolean }>) {
  const updates: Array<{ table: string; from: string; to: string }> = [];
  const upd = (table: string) => ({
    updateMany: jest.fn((a: any) => {
      updates.push({
        table,
        from: a.where.path ?? a.where.localPath,
        to: a.data.path ?? a.data.localPath,
      });
      return a;
    }),
  });
  const prisma = {
    mediaItem: { findMany: jest.fn(async () => items), ...upd('mediaItem') },
    mediaFile: upd('mediaFile'),
    mediaSubtitle: upd('mediaSubtitle'),
    mediaArtwork: upd('mediaArtwork'),
    $transaction: jest.fn(async (ops: unknown[]) => ops),
  };
  const filePath = {
    assertWithinHardRoots: jest.fn((p: string) => {
      if (!path.resolve(p).startsWith(path.resolve(root))) throw new Error('outside');
    }),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const svc = new DuplicateResolutionService(
    prisma as never,
    filePath as never,
    {} as never,
    {} as never,
    audit as never,
    { broadcast: jest.fn() } as never,
  );
  return { svc, prisma, audit, updates };
}

describe('restoring an orphaned [dupN] name', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'dup-suffix-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function film(name: string, extras: string[] = []) {
    const dir = path.join(root, name.replace(/ - 1080p.*/, ''));
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await writeFile(file, 'FILM');
    for (const e of extras) await writeFile(path.join(dir, e), 'x');
    return { dir, file };
  }

  it('renames the file when the canonical name is free', async () => {
    const { file, dir } = await film('Big Baby (2025) - 1080p [dup2].mp4');
    const { svc } = build(root, [{ id: 'i1', path: file }]);

    const out = await svc.restoreOrphanedSuffixes();

    expect(out.restored).toBe(1);
    expect(await readdir(dir)).toEqual(['Big Baby (2025) - 1080p.mp4']);
  });

  it('takes the sidecars with it', async () => {
    // A subtitle named after the suffixed video would stop matching it the
    // moment the video is renamed, so the whole family moves together.
    const { file, dir } = await film('Soulm8te (2026) - 1080p [dup2].mp4', [
      'Soulm8te (2026) - 1080p [dup2].eng.srt',
      'Soulm8te (2026) - 1080p [dup2].spa.srt',
    ]);
    const { svc } = build(root, [{ id: 'i1', path: file }]);

    await svc.restoreOrphanedSuffixes();

    expect((await readdir(dir)).sort()).toEqual([
      'Soulm8te (2026) - 1080p.eng.srt',
      'Soulm8te (2026) - 1080p.mp4',
      'Soulm8te (2026) - 1080p.spa.srt',
    ]);
  });

  it('points the index at the new name', async () => {
    /*
     * The half that was missing from the existing restoration. Renaming the file
     * and leaving `MediaFile.path` on the old name gives the library a row for a
     * file that no longer exists — and the next scan adopts the new name as a
     * SECOND item, manufacturing a duplicate out of the cleanup.
     */
    const { file } = await film('Evil Dead Burn (2026) - 1080p [dup2].mp4');
    const { svc, updates } = build(root, [{ id: 'i1', path: file }]);

    await svc.restoreOrphanedSuffixes();

    const tables = updates.filter((u) => u.from === file).map((u) => u.table).sort();
    expect(tables).toEqual(['mediaArtwork', 'mediaFile', 'mediaItem', 'mediaSubtitle']);
    expect(updates[0].to).toBe(file.replace(' [dup2]', ''));
  });
});

describe('what the sweep refuses to touch', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'dup-suffix-guard-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('leaves a REAL duplicate alone', async () => {
    /*
     * The whole safety boundary. If the canonical name is occupied, the two
     * files are a genuine duplicate pair and which one survives is the
     * operator's decision, made in the Duplicate Center. A sweep that renamed
     * here would either clobber a file or silently pick a winner.
     */
    const dir = path.join(root, 'Silo');
    await mkdir(dir, { recursive: true });
    const canonical = path.join(dir, 'Silo - S03E06.mkv');
    const suffixed = path.join(dir, 'Silo - S03E06 [dup2].mkv');
    await writeFile(canonical, 'A');
    await writeFile(suffixed, 'B');

    const { svc, audit } = build(root, [{ id: 'i1', path: suffixed }]);
    const out = await svc.restoreOrphanedSuffixes();

    expect(out.restored).toBe(0);
    expect(out.details[0].reason).toBe('canonical name is taken');
    expect((await readdir(dir)).sort()).toEqual(['Silo - S03E06 [dup2].mkv', 'Silo - S03E06.mkv']);
    // Nothing happened, so nothing is audited.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('skips a locked item', async () => {
    // `locked` takes an item out of every automated path; a cosmetic rename is
    // no exception.
    const dir = path.join(root, 'Locked');
    await mkdir(dir, { recursive: true });
    const p = path.join(dir, 'Locked (2025) [dup2].mp4');
    await writeFile(p, 'x');

    const { svc } = build(root, [{ id: 'i1', path: p, locked: true }]);
    const out = await svc.restoreOrphanedSuffixes();

    expect(out.restored).toBe(0);
    expect(out.details[0].reason).toBe('item is locked');
    expect(await readdir(dir)).toEqual(['Locked (2025) [dup2].mp4']);
  });

  it('skips a path outside the allowed roots', async () => {
    const { svc } = build(root, [{ id: 'i1', path: '/etc/passwd [dup2].mp4' }]);
    const out = await svc.restoreOrphanedSuffixes();

    expect(out.restored).toBe(0);
    expect(out.details[0].reason).toBe('outside the allowed roots');
  });

  it('deletes nothing, ever', async () => {
    // The sweep has no delete path at all. Two files in, two files out.
    const dir = path.join(root, 'Keep');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'Keep (2025) [dup2].mp4'), 'a');
    await writeFile(path.join(dir, 'Keep (2025) [dup2].srt'), 'b');

    const { svc } = build(root, [{ id: 'i1', path: path.join(dir, 'Keep (2025) [dup2].mp4') }]);
    await svc.restoreOrphanedSuffixes();

    expect((await readdir(dir)).length).toBe(2);
  });

  it('reports a row whose file is gone, instead of promising a rename', async () => {
    /*
     * The index can outlive the file. Live on ehr-qnap: a `media_items` row
     * pointed at "Evolution (2026) - 1080p [dup2].mp4" that was not on disk, so
     * the dry run — which only checked that the DESTINATION was free — said
     * "restore" and the run said "nothing was renamed". A preview that
     * disagrees with the run is how an operator learns to stop reading it.
     */
    const dir = path.join(root, 'Ghost');
    await mkdir(dir, { recursive: true });
    const missing = path.join(dir, 'Ghost (2026) - 1080p [dup2].mp4');

    const { svc } = build(root, [{ id: 'i1', path: missing }]);

    for (const dryRun of [true, false]) {
      const out = await svc.restoreOrphanedSuffixes({}, { dryRun });
      expect(out.restored).toBe(0);
      expect(out.details[0].reason).toBe('the file no longer exists');
    }
  });

  it('reports without touching anything on a dry run', async () => {
    const dir = path.join(root, 'Dry');
    await mkdir(dir, { recursive: true });
    const p = path.join(dir, 'Dry (2025) - 1080p [dup2].mp4');
    await writeFile(p, 'x');

    const { svc, updates } = build(root, [{ id: 'i1', path: p }]);
    const out = await svc.restoreOrphanedSuffixes({}, { dryRun: true });

    expect(out.restored).toBe(1);
    expect(out.details[0].to).toBe(p.replace(' [dup2]', ''));
    expect(await readdir(dir)).toEqual(['Dry (2025) - 1080p [dup2].mp4']);
    expect(updates).toHaveLength(0);
  });
});
