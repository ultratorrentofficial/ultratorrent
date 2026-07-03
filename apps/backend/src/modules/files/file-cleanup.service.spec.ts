import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCleanupService } from './file-cleanup.service';
import { FilePathService } from './file-path.service';
import { pathExists } from './file-fs.util';
import type { CleanupCategory } from '@ultratorrent/shared';

function configFor(root: string): any {
  return { get: (k: string) => (k === 'fileManager.roots' ? [root] : undefined) };
}

describe('FileCleanupService', () => {
  let root: string;
  let svc: FileCleanupService;
  let trash: { moveToTrash: jest.Mock };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ut-cleanup-'));
    const paths = new FilePathService(configFor(root), { get: async () => undefined, set: async () => {} } as any);
    trash = { moveToTrash: jest.fn().mockResolvedValue({ size: 0 }) };
    svc = new FileCleanupService(
      paths as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      { broadcast: jest.fn() } as any,
      trash as any,
    );

    // Fixture
    await writeFile(join(root, 'movie.sample.mkv'), 'x');
    await writeFile(join(root, 'zero.bin'), '');
    await writeFile(join(root, 'info.nfo'), 'nfo');
    await writeFile(join(root, 'check.sfv'), 'sfv');
    await writeFile(join(root, 'readme.txt'), 'txt');
    await writeFile(join(root, '.hidden'), 'h');
    await writeFile(join(root, 'download.part'), 'partial');
    await writeFile(join(root, 'dup1.dat'), 'identical-bytes');
    await writeFile(join(root, 'dup2.dat'), 'identical-bytes');
    await mkdir(join(root, 'emptyfolder'));
    await mkdir(join(root, 'subs'));
    await writeFile(join(root, 'subs', 'orphan.srt'), 'sub');
    await mkdir(join(root, 'art'));
    await writeFile(join(root, 'art', 'poster.jpg'), 'img');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('classifies cleanup candidates by category', async () => {
    const preview = await svc.preview({ path: '/' });
    const cats = new Set<CleanupCategory>(preview.categories.map((c) => c.category));
    for (const expected of [
      'sample_files',
      'zero_byte_files',
      'nfo_files',
      'sfv_files',
      'txt_files',
      'hidden_temp_files',
      'partial_downloads',
      'duplicate_files',
      'orphan_subtitles',
      'orphan_artwork',
      'empty_folders',
    ] as CleanupCategory[]) {
      expect(cats.has(expected)).toBe(true);
    }
    expect(preview.totalItems).toBeGreaterThan(0);
    expect(preview.estimatedSpaceSaved).toBe(preview.totalSize);
  });

  it('flags exactly one of an identical pair as duplicate', async () => {
    const preview = await svc.preview({ path: '/', categories: ['duplicate_files'] });
    const dup = preview.categories.find((c) => c.category === 'duplicate_files');
    expect(dup?.itemCount).toBe(1);
  });

  it('honours the category filter', async () => {
    const preview = await svc.preview({ path: '/', categories: ['nfo_files'] });
    expect(preview.categories).toHaveLength(1);
    expect(preview.categories[0].category).toBe('nfo_files');
  });

  it('executes a permanent cleanup of selected items only', async () => {
    const res = await svc.execute({ path: '/', paths: ['/zero.bin', '/info.nfo'], permanent: true });
    expect(res.removed).toBe(2);
    expect(res.failed).toBe(0);
    expect(await pathExists(join(root, 'zero.bin'))).toBe(false);
    expect(await pathExists(join(root, 'info.nfo'))).toBe(false);
    // untouched
    expect(await pathExists(join(root, 'readme.txt'))).toBe(true);
  });

  it('routes a non-permanent cleanup through the trash', async () => {
    await svc.execute({ path: '/', paths: ['/readme.txt'] });
    expect(trash.moveToTrash).toHaveBeenCalledTimes(1);
  });
});
