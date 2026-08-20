/**
 * A symlink inside a root must not become a way out of it.
 *
 * `path.resolve` normalises `../` but does not follow links, so containment
 * checked logically passes for `<root>/escape -> /etc`. That matters here more
 * than in most systems: torrent payloads are supplied by strangers, may contain
 * symlinks, and land inside these roots by design.
 */
import { mkdtemp, mkdir, symlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PathSafety } from './path-safety';

let root: string;
let outside: string;
let safety: PathSafety;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ut-root-'));
  outside = await mkdtemp(path.join(tmpdir(), 'ut-outside-'));
  await mkdir(path.join(root, 'inside'), { recursive: true });
  await writeFile(path.join(outside, 'secret.txt'), 'x');
  await symlink(outside, path.join(root, 'escape'));
  safety = new PathSafety([root]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('symlink containment', () => {
  it('refuses a path that resolves outside the roots', async () => {
    await expect(safety.resolveExisting('/escape')).rejects.toThrow(/escapes/i);
  });

  it('refuses a file reached through the link', async () => {
    await expect(safety.resolveExisting('/escape/secret.txt')).rejects.toThrow(/escapes/i);
  });

  it('still allows an ordinary directory inside the root', async () => {
    await expect(safety.resolveExisting('/inside')).resolves.toContain('inside');
  });

  it('allows a path that does not exist yet, which is the create case', async () => {
    // `realpath` cannot resolve what is not there; the logical check stands, and
    // this is what makes the same call usable for a new folder's destination.
    await expect(safety.resolveExisting('/inside/new-folder')).resolves.toContain('new-folder');
  });

  it('does not confuse a sibling root prefix for containment', async () => {
    // The classic `/data` vs `/data-evil` slip.
    await expect(safety.resolveExisting(`../${path.basename(root)}-evil`)).rejects.toThrow();
  });
});
