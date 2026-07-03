import { BadRequestException } from '@nestjs/common';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { FilePathService, DEFAULT_ROOT_PATH_KEY } from './file-path.service';

/** Minimal in-memory SettingsService double. */
function settingsDouble(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: jest.fn(async (key: string) => store.get(key)),
    set: jest.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    getAll: jest.fn(async () => Object.fromEntries(store)),
    _store: store,
  };
}

function configDouble(roots: string[]) {
  return { get: (key: string) => (key === 'fileManager.roots' ? roots : undefined) } as any;
}

describe('FilePathService (Default Root Path)', () => {
  let hardRoot: string;
  let subDir: string;
  let aFile: string;

  beforeAll(() => {
    hardRoot = mkdtempSync(path.join(tmpdir(), 'ut-root-'));
    subDir = path.join(hardRoot, 'movies');
    mkdirSync(subDir);
    aFile = path.join(hardRoot, 'note.txt');
    writeFileSync(aFile, 'x');
  });

  afterAll(() => {
    rmSync(hardRoot, { recursive: true, force: true });
  });

  const make = (settings = settingsDouble()) =>
    new FilePathService(configDouble([hardRoot]), settings as any);

  it('defaults to the env hard root when no setting is configured', async () => {
    const svc = make();
    await svc.refresh();
    expect(svc.safety.listRoots()).toEqual([hardRoot]);
    const info = await svc.rootInfo();
    expect(info.root).toBe(hardRoot);
    expect(info.exists).toBe(true);
    expect(info.readable).toBe(true);
    expect(info.hardRoots).toEqual([hardRoot]);
  });

  it('narrows browsing to a valid sub-directory and persists it', async () => {
    const settings = settingsDouble();
    const svc = make(settings);
    const { previous, rootInfo } = await svc.setDefaultRoot(subDir);
    expect(previous).toBeNull();
    expect(rootInfo.root).toBe(subDir);
    expect(svc.safety.listRoots()).toEqual([subDir]);
    expect(settings.set).toHaveBeenCalledWith(DEFAULT_ROOT_PATH_KEY, subDir);
    // Absolute-looking input is sandboxed into the narrowed root, not the hard root.
    expect(svc.safety.resolveLogical('/etc')).toBe(path.join(subDir, 'etc'));
  });

  it('rejects a path outside the env hard roots', async () => {
    const svc = make();
    await expect(svc.setDefaultRoot('/tmp')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a protected system directory', async () => {
    const svc = make();
    await expect(svc.setDefaultRoot('/etc')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects traversal that climbs out of the hard root', async () => {
    const svc = make();
    await expect(
      svc.setDefaultRoot(path.join(hardRoot, '..', '..')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-existent path', async () => {
    const svc = make();
    await expect(
      svc.setDefaultRoot(path.join(hardRoot, 'does-not-exist')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a file (must be a directory)', async () => {
    const svc = make();
    await expect(svc.setDefaultRoot(aFile)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an empty path', async () => {
    const svc = make();
    await expect(svc.setDefaultRoot('   ')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ignores a configured root that is outside the hard roots (falls back safely)', async () => {
    const settings = settingsDouble({ [DEFAULT_ROOT_PATH_KEY]: '/etc' });
    const svc = make(settings);
    await svc.refresh();
    expect(svc.safety.listRoots()).toEqual([hardRoot]);
  });
});
