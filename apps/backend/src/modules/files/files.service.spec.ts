import { ConflictException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesService } from './files.service';
import { FilePathService } from './file-path.service';
import { pathExists } from './file-fs.util';

function configFor(root: string): any {
  return { get: (k: string) => (k === 'fileManager.roots' ? [root] : undefined) };
}

describe('FilesService', () => {
  let root: string;
  let svc: FilesService;
  let audit: { record: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let trash: { moveToTrash: jest.Mock };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ut-files-'));
    const paths = new FilePathService(configFor(root), { get: async () => undefined, set: async () => {} } as any);
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    realtime = { broadcast: jest.fn() };
    trash = { moveToTrash: jest.fn().mockResolvedValue({ size: 5 }) };
    svc = new FilesService(paths as any, audit as any, realtime as any, trash as any);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates a folder and audits it', async () => {
    const res = await svc.createFolder({ path: '/', name: 'movies' });
    expect(res.ok).toBe(true);
    expect(await pathExists(join(root, 'movies'))).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'file.created_folder' }),
    );
  });

  it('refuses to create a duplicate folder', async () => {
    await svc.createFolder({ path: '/', name: 'dup' });
    await expect(svc.createFolder({ path: '/', name: 'dup' })).rejects.toThrow(ConflictException);
  });

  it('renames a file', async () => {
    await writeFile(join(root, 'a.txt'), 'hi');
    const res = await svc.rename({ path: '/a.txt', newName: 'b.txt' });
    expect(res.path).toBe('/b.txt');
    expect(await pathExists(join(root, 'a.txt'))).toBe(false);
    expect(await pathExists(join(root, 'b.txt'))).toBe(true);
  });

  it('blocks rename overwrite without confirmation', async () => {
    await writeFile(join(root, 'a.txt'), 'a');
    await writeFile(join(root, 'b.txt'), 'b');
    await expect(svc.rename({ path: '/a.txt', newName: 'b.txt' })).rejects.toThrow(ConflictException);
  });

  it('moves a file into a subdirectory', async () => {
    await writeFile(join(root, 'a.txt'), 'a');
    await mkdir(join(root, 'sub'));
    const res = await svc.move({ source: '/a.txt', destination: '/sub' });
    expect(res.path).toBe('/sub/a.txt');
    expect(await pathExists(join(root, 'sub', 'a.txt'))).toBe(true);
  });

  it('copies a directory recursively', async () => {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'inner.txt'), 'x');
    await mkdir(join(root, 'dst'));
    await svc.copy({ source: '/src', destination: '/dst' });
    expect(await pathExists(join(root, 'dst', 'src', 'inner.txt'))).toBe(true);
    // original untouched
    expect(await pathExists(join(root, 'src', 'inner.txt'))).toBe(true);
  });

  it('refuses to move a folder into itself', async () => {
    await mkdir(join(root, 'a'));
    await expect(svc.move({ source: '/a', destination: '/a' })).rejects.toThrow(BadRequestException);
  });

  it('permanently deletes when requested', async () => {
    await writeFile(join(root, 'gone.txt'), 'bye');
    const res = await svc.remove({ path: '/gone.txt', permanent: true });
    expect(res.ok).toBe(true);
    expect(await pathExists(join(root, 'gone.txt'))).toBe(false);
    expect(trash.moveToTrash).not.toHaveBeenCalled();
  });

  it('routes a soft delete through the trash service', async () => {
    await writeFile(join(root, 'soft.txt'), 'data');
    await svc.remove({ path: '/soft.txt' });
    expect(trash.moveToTrash).toHaveBeenCalledTimes(1);
  });

  it('refuses to delete a configured root', async () => {
    await expect(svc.remove({ path: '/', permanent: true })).rejects.toThrow(ForbiddenException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'file.operation_failed' }),
    );
  });

  it('reports per-item results for bulk delete', async () => {
    await writeFile(join(root, '1.txt'), '1');
    await writeFile(join(root, '2.txt'), '2');
    const res = await svc.bulk({ operation: 'delete', paths: ['/1.txt', '/2.txt'], permanent: true });
    expect(res.succeeded).toBe(2);
    expect(res.failed).toBe(0);
  });
});
