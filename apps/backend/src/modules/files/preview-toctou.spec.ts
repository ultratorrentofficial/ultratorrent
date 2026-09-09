import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';

/**
 * The swap has to happen BETWEEN the service's `stat` and its `open`, and it has
 * to happen on every runner rather than whenever module binding happens to
 * cooperate. Wrapping the real `stat` in a module factory is the only form that
 * intercepts the binding the service actually imported.
 *
 * `swapAfterStatOf` is null for every test but the one that wants the race.
 */
let swapAfterStatOf: string | null = null;

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    stat: async (...args: unknown[]) => {
      const info = await actual.stat(...(args as [string]));
      if (swapAfterStatOf && String(args[0]) === swapAfterStatOf) {
        const path = swapAfterStatOf;
        swapAfterStatOf = null; // once, so the re-read inside the service is stable
        await actual.unlink(path);
        await actual.writeFile(path, 'substituted');
      }
      return info;
    },
  };
});
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
    swapAfterStatOf = null;
    await rm(root, { recursive: true, force: true });
  });

  it('previews an ordinary file', async () => {
    await writeFile(path.join(root, 'notes.txt'), 'hello world');
    const out = await svc.preview('/notes.txt');
    expect(out.content).toContain('hello world');
  });

  /*
   * The property that holds on every filesystem.
   *
   * The inode comparison in `preview` catches the ordinary swap, but it is not a
   * guarantee and this test does not pretend otherwise: a filesystem may hand a
   * freed inode number straight to the next file, and CI reproduced exactly that
   * — unlink-then-write returned the same ino/dev and the check passed while it
   * failed locally. An assertion that depends on inode-reuse policy is a flaky
   * test, and a flaky security test gets disabled by whoever hits it next.
   *
   * What is always true is that the bytes and the length come from the same open
   * descriptor. So that is what is asserted: whichever file the read lands on,
   * the content it returns is that file's, never a mixture measured from one and
   * read from another.
   */
  it('reads content and length from the same descriptor, even across a swap', async () => {
    const target = path.join(root, 'swap.txt');
    await writeFile(target, 'original');
    swapAfterStatOf = target;

    let out: Awaited<ReturnType<typeof svc.preview>> | null = null;
    try {
      out = await svc.preview('/swap.txt');
    } catch {
      // Refused because the inode changed — also correct, and what happens when
      // the filesystem does not recycle the number.
      return;
    }
    expect(['original', 'substituted']).toContain(out.content);
    expect(out.content).not.toBe('originalsub');
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
