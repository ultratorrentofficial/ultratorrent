import { ForbiddenException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FilePathService } from './file-path.service';

/**
 * Exercises the inspect() / ensureDirectory() helpers that back the
 * "validate against the hard root + offer to create a missing folder" flow,
 * against a real temp directory used as the single hard root.
 */
describe('FilePathService — inspect + ensureDirectory', () => {
  let root: string;
  let svc: FilePathService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ut-hardroot-'));
    const config = {
      get: (key: string) => (key === 'fileManager.roots' ? [root] : undefined),
    } as any;
    const settings = { get: async () => undefined } as any;
    svc = new FilePathService(config, settings);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports an existing in-root directory as within-roots, existing, writable', async () => {
    const info = await svc.inspect(root);
    expect(info.withinHardRoots).toBe(true);
    expect(info.isSystemDir).toBe(false);
    expect(info.exists).toBe(true);
    expect(info.isDirectory).toBe(true);
    expect(info.writable).toBe(true);
  });

  it('flags a path outside the hard roots', async () => {
    const info = await svc.inspect(path.join(os.tmpdir(), 'ut-somewhere-else-xyz'));
    expect(info.withinHardRoots).toBe(false);
  });

  it('reports a within-root but missing path as allowed-yet-absent', async () => {
    const info = await svc.inspect(path.join(root, 'tv', 'shows'));
    expect(info.withinHardRoots).toBe(true);
    expect(info.exists).toBe(false);
    expect(info.isDirectory).toBe(false);
  });

  it('ensureDirectory creates a missing in-root directory (recursively)', async () => {
    const target = path.join(root, 'movies', '4k');
    const info = await svc.ensureDirectory(target);
    expect(info.exists).toBe(true);
    expect(info.isDirectory).toBe(true);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });

  it('ensureDirectory is idempotent for an existing directory', async () => {
    const info = await svc.ensureDirectory(root);
    expect(info.exists).toBe(true);
    expect(info.isDirectory).toBe(true);
  });

  it('ensureDirectory refuses a path outside the hard roots', async () => {
    await expect(
      svc.ensureDirectory(path.join(os.tmpdir(), 'ut-escape-xyz')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
