import { link, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MediaService } from './media.service';

/**
 * A rename whose destination is occupied must never REPLACE what is there.
 *
 * The engine's undo is a replay of recorded moves in reverse, so a file removed
 * by an overwrite is absent from every log and cannot be restored — the loss is
 * silent and permanent.
 *
 * What happens *instead* of the overwrite changed on 2026-08-16. It used to be
 * a plain failure, which was safe for the incumbent but abandoned the newcomer:
 * the file stayed in its release folder, a release folder belongs to no
 * library, and duplicate detection only ever looks inside libraries — so the
 * copy was invisible, the operator was never offered the keep/discard decision,
 * and every later organise run re-attempted and re-failed it. One live library
 * accumulated 187 of them (~82 GB) before anyone could see why.
 *
 * Media Intake had already solved this with the `[dupN]` convention; this path
 * had not. The contract now pinned:
 *
 *   - the occupying file keeps its name AND its contents,
 *   - the newcomer is placed beside it as `<name> [dupN]`, so both are in the
 *     library and the Duplicate Center can offer the decision,
 *   - the run counts it in `applied` and in `duplicates`, never in `failed`,
 *   - the recorded operation names the path the file is ACTUALLY at, because
 *     undo moves `destination` back to `source`,
 *   - and a destination that is the very same file is `skipped`, not duplicated
 *     — a re-run of an applied plan must not manufacture a second copy.
 *
 * Driven through the real `apply` against a real temp directory: the behaviour
 * under test is what the filesystem does, which a mocked fs cannot show.
 */
function buildService(root: string, ops: any[]) {
  const prisma = {
    mediaLibrary: { findMany: jest.fn(async () => [{ path: root }]) },
    mediaRenameOperation: {
      create: jest.fn(async ({ data }: any) => {
        ops.push(data);
        return data;
      }),
    },
    mediaItem: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  };
  const config = { get: jest.fn(() => undefined) };
  const settings = { get: jest.fn(async () => undefined) };
  const registry = {};
  const audit = { record: jest.fn(async () => undefined) };
  const relocation = { recordMoveSafe: jest.fn(async () => undefined), recordDelete: jest.fn(async () => undefined) };
  const providers = { chain: jest.fn(async () => []), offline: jest.fn(() => ({ fetchDetails: async () => null })) };
  return new MediaService(
    prisma as never, config as never, settings as never, registry as never,
    audit as never, relocation as never, providers as never,
  );
}

/** Drive the apply loop with one planned move; buildPlan is exercised elsewhere. */
function planOneMove(svc: MediaService, root: string, source: string, destination: string) {
  jest.spyOn(svc as never, 'buildPlan' as never).mockResolvedValue({
    mode: 'rename_in_place',
    libraryPath: root,
    preset: 'plex',
    kind: 'movie',
    parsed: { title: 'Maze', year: 2017 },
    items: [
      { source, destination, action: 'rename', kind: 'movie',
        skipped: false, unchanged: false, isSubtitle: false, reason: 'primary media file' },
    ],
  } as never);
}

describe('rename onto an occupied destination', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rename-collision-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('places the newcomer as [dup2] and leaves the occupying file untouched', async () => {
    const src = path.join(root, 'Maze (2017) - 1080p.mp4');
    const dest = path.join(root, 'The Maze Runner (2014) - 1080p.mp4');
    await writeFile(src, 'THE FILM BEING MOVED');
    await writeFile(dest, 'THE FILM ALREADY THERE');

    const ops: any[] = [];
    const svc = buildService(root, ops);
    planOneMove(svc, root, src, dest);

    const result = await svc.apply({ libraryPath: root, mode: 'rename_in_place' } as never);

    expect(result.applied).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.failed).toBe(0);

    // The incumbent kept its name and its bytes.
    expect(await readFile(dest, 'utf8')).toBe('THE FILM ALREADY THERE');

    // The newcomer is in the library beside it, suffixed — not left at its
    // source, which is what made these copies invisible before.
    const dup = path.join(root, 'The Maze Runner (2014) - 1080p [dup2].mp4');
    expect(await readFile(dup, 'utf8')).toBe('THE FILM BEING MOVED');
    expect((await readdir(root)).sort()).toEqual([
      'The Maze Runner (2014) - 1080p [dup2].mp4',
      'The Maze Runner (2014) - 1080p.mp4',
    ]);

    // Recorded as a success at the path the file is actually at, so undo can
    // reverse it, and with a reason so the suffix is traceable.
    const success = ops.filter((o) => o.status === 'success');
    expect(success).toHaveLength(1);
    expect(success[0].source).toBe(src);
    expect(success[0].destination).toBe(dup);
    expect(success[0].message).toMatch(/canonical name was taken/i);
    expect(ops.filter((o) => o.status === 'failed')).toHaveLength(0);
  });

  it('walks up to the next free suffix when [dup2] is taken too', async () => {
    const src = path.join(root, 'Maze (2017) - 1080p.mp4');
    const dest = path.join(root, 'The Maze Runner (2014) - 1080p.mp4');
    await writeFile(src, 'THIRD COPY');
    await writeFile(dest, 'FIRST COPY');
    await writeFile(path.join(root, 'The Maze Runner (2014) - 1080p [dup2].mp4'), 'SECOND COPY');

    const ops: any[] = [];
    const svc = buildService(root, ops);
    planOneMove(svc, root, src, dest);

    const result = await svc.apply({ libraryPath: root, mode: 'rename_in_place' } as never);

    expect(result.duplicates).toBe(1);
    expect(await readFile(path.join(root, 'The Maze Runner (2014) - 1080p [dup3].mp4'), 'utf8'))
      .toBe('THIRD COPY');
    // The existing pair is undisturbed.
    expect(await readFile(dest, 'utf8')).toBe('FIRST COPY');
    expect(await readFile(path.join(root, 'The Maze Runner (2014) - 1080p [dup2].mp4'), 'utf8'))
      .toBe('SECOND COPY');
  });

  it('skips — never duplicates — when the destination IS the source file', async () => {
    // The re-run case: a plan derived from the source still offers the move
    // after an earlier run already placed it. Same inode, so there is nothing
    // to do and nothing to duplicate.
    const src = path.join(root, 'Maze (2017) - 1080p.mp4');
    const dest = path.join(root, 'The Maze Runner (2014) - 1080p.mp4');
    await writeFile(src, 'PAYLOAD');
    await link(src, dest);

    const ops: any[] = [];
    const svc = buildService(root, ops);
    planOneMove(svc, root, src, dest);

    const result = await svc.apply({ libraryPath: root, mode: 'rename_in_place' } as never);

    expect(result.applied).toBe(0);
    expect(result.duplicates).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);

    // No [dupN] was invented.
    expect((await readdir(root)).sort()).toEqual([
      'Maze (2017) - 1080p.mp4',
      'The Maze Runner (2014) - 1080p.mp4',
    ]);
    const skipped = ops.filter((o) => o.status === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].message).toMatch(/already at the destination/i);
  });

  it('still renames normally when the destination is free', async () => {
    const src = path.join(root, 'The Maze Runner (2014) - 1080p.mp4');
    const dest = path.join(root, 'Maze (2017) - 1080p.mp4');
    await writeFile(src, 'PAYLOAD');

    const ops: any[] = [];
    const svc = buildService(root, ops);
    planOneMove(svc, root, src, dest);

    const result = await svc.apply({ libraryPath: root, mode: 'rename_in_place' } as never);
    expect(result.applied).toBe(1);
    expect(result.duplicates).toBe(0);
    expect(result.failed).toBe(0);
    expect(await readFile(dest, 'utf8')).toBe('PAYLOAD');
    expect(ops.filter((o) => o.status === 'success')).toHaveLength(1);
  });
});
