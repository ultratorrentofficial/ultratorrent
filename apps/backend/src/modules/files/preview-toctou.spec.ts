import { BadRequestException } from '@nestjs/common';
import { mkdtemp, mkdir, writeFile, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FilesService } from './files.service';
import { PathSafety } from './path-safety';

/**
 * Time-of-check to time-of-use, on real files.
 *
 * Containment is established against a PATH — resolved, symlink-followed and
 * asserted inside a root. A path is a name, not a thing: between the check and
 * the read, what the name refers to can be replaced. Anyone able to write into a
 * media directory can do it, and that includes a torrent unpacking into one.
 *
 * Mocking `fs` would prove nothing here, because the property under test is what
 * the filesystem does with names and inodes. These use a real temporary
 * directory and a real swap.
 */
describe('previewing a file that is replaced underneath the read', () => {
  let root: string;
  let svc: FilesService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ut-toctou-'));
    const safety = new PathSafety([root]);
    // The service reaches PathSafety through FilePathService; only that and the
    // audit sink are touched by `preview`, so the rest are left unbuilt.
    const paths = { safety } as never;
    const audit = { record: async () => undefined } as never;
    svc = new FilesService(paths, audit, {} as never, {} as never, {} as never, {} as never);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('previews an ordinary file', async () => {
    await writeFile(path.join(root, 'notes.txt'), 'hello world');
    const out = await svc.preview('/notes.txt');
    expect(out.content).toContain('hello world');
  });

  /*
   * The swap this guards against. The file is replaced between the `stat` that
   * establishes its identity and the `open` that reads it, so the descriptor
   * refers to a different inode than the one that was checked.
   */
  it('refuses when the file is swapped for another between check and read', async () => {
    const target = path.join(root, 'swap.txt');
    const decoy = path.join(root, 'decoy.txt');
    await writeFile(target, 'original');
    await writeFile(decoy, 'substituted');

    const realStat = jest.requireActual('node:fs/promises').stat;
    const fsp = require('node:fs/promises');
    const spy = jest.spyOn(fsp, 'stat').mockImplementation(async (...args: unknown[]) => {
      const info = await realStat(...(args as [string]));
      // The check has happened; swap the name before the read opens it.
      if (String(args[0]) === target) {
        await unlink(target);
        await writeFile(target, 'substituted');
      }
      return info;
    });

    try {
      await expect(svc.preview('/swap.txt')).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      spy.mockRestore();
    }
  });

  /*
   * A symlink INSIDE the root that points outside it is caught by the existing
   * containment check, before any of this. Asserted here so the two mechanisms
   * are visibly distinct: containment handles the name, the inode check handles
   * the swap.
   */
  it('still refuses a symlink pointing outside the root', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'ut-outside-'));
    await writeFile(path.join(outside, 'secret.txt'), 'not yours');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    try {
      await expect(svc.preview('/link.txt')).rejects.toBeTruthy();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('previews a file inside a subdirectory', async () => {
    await mkdir(path.join(root, 'sub'), { recursive: true });
    await writeFile(path.join(root, 'sub', 'a.txt'), 'nested');
    const out = await svc.preview('/sub/a.txt');
    expect(out.content).toContain('nested');
  });
});
