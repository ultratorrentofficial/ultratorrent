import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { LocalRepositoryProvider } from './local-repository.provider';

/**
 * The local provider was the only one that read without a size limit.
 *
 * Each remote provider refuses a body over 3 MB. This one read whatever was on
 * disk straight into a string, and containment — the file is inside a storage
 * root — says nothing about how big it is. A torrent unpacking into the library
 * is enough to put a very large file with a `.srt` name there, and `readFile`
 * would load the whole thing into memory before the parser saw a line.
 */
describe('a local subtitle is bounded like a downloaded one', () => {
  let root: string;
  let provider: LocalRepositoryProvider;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ut-subs-'));
    // (config, guard) — the guard is what resolves and contains the path.
    const guard = { assertWithinHardRoots: (p: string) => p } as never;
    provider = new LocalRepositoryProvider({ repoPath: root } as never, guard);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const candidate = (file: string) =>
    ({ providerFileId: file, downloadUrl: `local:${file}` }) as never;

  it('reads an ordinary subtitle', async () => {
    const file = path.join(root, 'ok.srt');
    await writeFile(file, '1\n00:00:01,000 --> 00:00:04,000\nHello\n');
    const out = await provider.download(candidate(file));
    expect(out.content).toContain('Hello');
    expect(out.format).toBe('srt');
  });

  it('refuses a file past the limit rather than reading it into memory', async () => {
    const file = path.join(root, 'huge.srt');
    // Just over 3 MB — large enough to cross the limit, small enough to write fast.
    await writeFile(file, 'x'.repeat(3 * 1024 * 1024 + 1));
    await expect(provider.download(candidate(file))).rejects.toThrow(/too large/i);
  });

  it('accepts a file just under the limit', async () => {
    const file = path.join(root, 'big.srt');
    await writeFile(file, 'x'.repeat(3 * 1024 * 1024 - 1));
    await expect(provider.download(candidate(file))).resolves.toBeTruthy();
  });

  it('says how big the file was, so the cause is obvious', async () => {
    const file = path.join(root, 'huge2.srt');
    await writeFile(file, 'x'.repeat(3 * 1024 * 1024 + 10));
    await expect(provider.download(candidate(file))).rejects.toThrow(/\d+ bytes/);
  });
});
