import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MediaService } from './media.service';

/**
 * A rename whose destination is occupied must FAIL, not replace.
 *
 * The engine's undo is a replay of recorded moves in reverse, so a file removed
 * by an overwrite is absent from every log and cannot be restored — the loss is
 * silent and permanent. The contract this pins:
 *
 *   - the occupying file keeps its contents,
 *   - the source stays exactly where it was,
 *   - the run counts it in `failed`, never `applied`,
 *   - and a rename operation is recorded with status `failed` and a reason, so
 *     the collision is visible afterwards rather than inferred from a mismatch.
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

describe('rename onto an occupied destination', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rename-collision-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('leaves both files intact, counts a failure, and records why', async () => {
    const src = path.join(root, 'Maze (2017) - 1080p.mp4');
    const dest = path.join(root, 'The Maze Runner (2014) - 1080p.mp4');
    await writeFile(src, 'THE FILM BEING MOVED');
    await writeFile(dest, 'THE FILM ALREADY THERE');

    const ops: any[] = [];
    const svc = buildService(root, ops);
    // Drive the apply loop directly with a plan whose destination is occupied —
    // buildPlan's own derivation is exercised elsewhere; the collision is the
    // subject here.
    jest.spyOn(svc as never, 'buildPlan' as never).mockResolvedValue({
      mode: 'rename_in_place',
      libraryPath: root,
      preset: 'plex',
      kind: 'movie',
      parsed: { title: 'Maze', year: 2017 },
      items: [
        { source: src, destination: dest, action: 'rename', kind: 'movie',
          skipped: false, unchanged: false, isSubtitle: false, reason: 'primary media file' },
      ],
    } as never);

    const result = await svc.apply({ libraryPath: root, mode: 'rename_in_place' } as never);

    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);

    // Neither file moved or changed.
    expect(await readFile(dest, 'utf8')).toBe('THE FILM ALREADY THERE');
    expect(await readFile(src, 'utf8')).toBe('THE FILM BEING MOVED');

    // And the collision is on the record, with a reason naming the destination.
    const failed = ops.filter((o) => o.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].source).toBe(src);
    expect(failed[0].message).toMatch(/already exists/i);
    expect(failed[0].message).toContain(dest);
  });

  it('still renames normally when the destination is free', async () => {
    const src = path.join(root, 'The Maze Runner (2014) - 1080p.mp4');
    const dest = path.join(root, 'Maze (2017) - 1080p.mp4');
    await writeFile(src, 'PAYLOAD');

    const ops: any[] = [];
    const svc = buildService(root, ops);
    jest.spyOn(svc as never, 'buildPlan' as never).mockResolvedValue({
      mode: 'rename_in_place',
      libraryPath: root,
      preset: 'plex',
      kind: 'movie',
      parsed: { title: 'Maze', year: 2017 },
      items: [
        { source: src, destination: dest, action: 'rename', kind: 'movie',
          skipped: false, unchanged: false, isSubtitle: false, reason: 'primary media file' },
      ],
    } as never);

    const result = await svc.apply({ libraryPath: root, mode: 'rename_in_place' } as never);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(await readFile(dest, 'utf8')).toBe('PAYLOAD');
    expect(ops.filter((o) => o.status === 'success')).toHaveLength(1);
  });
});
