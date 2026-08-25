import { ConflictException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesService } from './files.service';
import { FilePathService } from './file-path.service';
import { pathExists } from './file-fs.util';

function configFor(...roots: string[]): any {
  return { get: (k: string) => (k === 'fileManager.roots' ? roots : undefined) };
}

describe('FilesService', () => {
  let root: string;
  let svc: FilesService;
  let bus: { publish: jest.Mock };
  let audit: { record: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let trash: { moveToTrash: jest.Mock };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ut-files-'));
    const paths = new FilePathService(configFor(root), { get: async () => undefined, set: async () => {} } as any);
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    realtime = { broadcast: jest.fn() };
    // The real TrashService relocates the file out of its original path; the
    // double must too, or a follow-on transfer sees a phantom name collision.
    trash = {
      moveToTrash: jest.fn(async (abs: string) => {
        await rm(abs, { recursive: true, force: true });
        return { size: 5 };
      }),
    };
    // The bus: file operations announce what they did so media records can
    // follow, without files depending on media (which would be a cycle).
    bus = { publish: jest.fn(() => ({ published: true })) };
    svc = new FilesService(paths as any, audit as any, realtime as any, trash as any, bus as any, { get: jest.fn() } as never);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /*
   * A second root was unreachable before this: browse rebased every request
   * onto roots[0], so a folder that lived only in the second root resolved to a
   * non-existent path under the first and surfaced as a 500 (ENOENT scandir) —
   * and a name present in BOTH silently served the first root's copy.
   */
  describe('with several roots', () => {
    let second: string;
    let multi: FilesService;

    beforeEach(async () => {
      second = await mkdtemp(join(tmpdir(), 'ut-files-2nd-'));
      const paths = new FilePathService(
        configFor(root, second),
        { get: async () => undefined, set: async () => {} } as any,
      );
      multi = new FilesService(paths as any, audit as any, realtime as any, trash as any, bus as any, { get: jest.fn() } as never);
    });

    afterEach(async () => {
      await rm(second, { recursive: true, force: true });
    });

    it('lists the roots themselves at the virtual root', async () => {
      const res = await multi.browse('/');
      expect(res.path).toBe('/');
      expect(res.roots).toEqual([root, second]);
      expect(res.items.map((i) => i.path).sort()).toEqual([root, second].sort());
      expect(res.items.every((i) => i.isDirectory)).toBe(true);
    });

    it('browses a directory in the SECOND root', async () => {
      await mkdir(join(second, 'TV Retro'));
      await writeFile(join(second, 'TV Retro', 'a.mkv'), 'x');
      const res = await multi.browse(join(second, 'TV Retro'));
      expect(res.path).toBe(join(second, 'TV Retro'));
      expect(res.items.map((i) => i.name)).toEqual(['a.mkv']);
      expect(res.items[0].path).toBe(join(second, 'TV Retro', 'a.mkv'));
    });

    it('keeps same-named folders in different roots distinct', async () => {
      await mkdir(join(root, 'Shared'));
      await writeFile(join(root, 'Shared', 'first.txt'), 'x');
      await mkdir(join(second, 'Shared'));
      await writeFile(join(second, 'Shared', 'second.txt'), 'x');
      expect((await multi.browse(join(root, 'Shared'))).items.map((i) => i.name)).toEqual(['first.txt']);
      expect((await multi.browse(join(second, 'Shared'))).items.map((i) => i.name)).toEqual(['second.txt']);
    });

    it('still refuses a path outside every root', async () => {
      await expect(multi.browse('/etc')).rejects.toThrow(ForbiddenException);
    });

    it('refuses to create a folder at the virtual root', async () => {
      await expect(multi.createFolder({ path: '/', name: 'nope' })).rejects.toThrow(ForbiddenException);
    });
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

  describe('resolveConflicts', () => {
    beforeEach(async () => {
      await mkdir(join(root, 'dst'));
    });

    it('replace: sends the target to Trash, then transfers the source in', async () => {
      await writeFile(join(root, 'ep.mkv'), 'new release');
      await writeFile(join(root, 'dst', 'ep.mkv'), 'old release');
      const res = await svc.resolveConflicts({
        operation: 'move',
        destination: '/dst',
        items: [{ source: '/ep.mkv', resolution: 'replace', targetPath: '/dst/ep.mkv' }],
      });
      expect(res.succeeded).toBe(1);
      // Old target went to Trash (soft), source moved into place.
      expect(trash.moveToTrash).toHaveBeenCalledWith(join(root, 'dst', 'ep.mkv'), expect.anything());
      expect(await pathExists(join(root, 'ep.mkv'))).toBe(false);
      expect(await pathExists(join(root, 'dst', 'ep.mkv'))).toBe(true);
    });

    it('replace with permanent: hard-deletes the target instead of trashing', async () => {
      await writeFile(join(root, 'ep.mkv'), 'new');
      await writeFile(join(root, 'dst', 'ep.mkv'), 'old');
      const res = await svc.resolveConflicts({
        operation: 'move',
        destination: '/dst',
        permanent: true,
        items: [{ source: '/ep.mkv', resolution: 'replace', targetPath: '/dst/ep.mkv' }],
      });
      expect(res.succeeded).toBe(1);
      expect(trash.moveToTrash).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'file.deleted', metadata: expect.objectContaining({ mode: 'permanent' }) }),
      );
    });

    it('delete_source: keeps the target, disposes of the source', async () => {
      await writeFile(join(root, 'ep.mkv'), 'dup');
      await writeFile(join(root, 'dst', 'ep.mkv'), 'kept');
      const res = await svc.resolveConflicts({
        operation: 'move',
        destination: '/dst',
        items: [{ source: '/ep.mkv', resolution: 'delete_source', targetPath: '/dst/ep.mkv' }],
      });
      expect(res.succeeded).toBe(1);
      expect(trash.moveToTrash).toHaveBeenCalledWith(join(root, 'ep.mkv'), expect.anything());
      // Target untouched.
      expect(await pathExists(join(root, 'dst', 'ep.mkv'))).toBe(true);
    });

    it('keep_both: renames the incoming file so both survive', async () => {
      await writeFile(join(root, 'ep.mkv'), 'incoming');
      await writeFile(join(root, 'dst', 'ep.mkv'), 'existing');
      const res = await svc.resolveConflicts({
        operation: 'move',
        destination: '/dst',
        items: [{ source: '/ep.mkv', resolution: 'keep_both', targetPath: '/dst/ep.mkv' }],
      });
      expect(res.succeeded).toBe(1);
      expect(res.results[0].message).toMatch(/ep \(2\)\.mkv/);
      expect(await pathExists(join(root, 'dst', 'ep.mkv'))).toBe(true);
      expect(await pathExists(join(root, 'dst', 'ep (2).mkv'))).toBe(true);
    });

    it('skip: leaves both files exactly as they are', async () => {
      await writeFile(join(root, 'ep.mkv'), 'incoming');
      await writeFile(join(root, 'dst', 'ep.mkv'), 'existing');
      const res = await svc.resolveConflicts({
        operation: 'move',
        destination: '/dst',
        items: [{ source: '/ep.mkv', resolution: 'skip', targetPath: '/dst/ep.mkv' }],
      });
      expect(res.results[0].message).toBe('skipped');
      expect(trash.moveToTrash).not.toHaveBeenCalled();
      expect(await pathExists(join(root, 'ep.mkv'))).toBe(true);
    });

    it('refuses a targetPath outside the destination directory', async () => {
      await writeFile(join(root, 'ep.mkv'), 'incoming');
      await writeFile(join(root, 'elsewhere.mkv'), 'not in dst');
      const res = await svc.resolveConflicts({
        operation: 'move',
        destination: '/dst',
        // A forged/stale target pointing outside the destination must not be deleted.
        items: [{ source: '/ep.mkv', resolution: 'replace', targetPath: '/elsewhere.mkv' }],
      });
      expect(res.failed).toBe(1);
      expect(res.results[0].message).toMatch(/not in the destination/i);
      // The out-of-scope file was never touched.
      expect(trash.moveToTrash).not.toHaveBeenCalled();
      expect(await pathExists(join(root, 'elsewhere.mkv'))).toBe(true);
    });

    it('reports per-item outcomes without aborting the batch', async () => {
      await writeFile(join(root, 'good.mkv'), 'ok');
      await writeFile(join(root, 'dst', 'good.mkv'), 'old');
      await writeFile(join(root, 'stale.mkv'), 'incoming');
      const res = await svc.resolveConflicts({
        operation: 'move',
        destination: '/dst',
        items: [
          { source: '/good.mkv', resolution: 'replace', targetPath: '/dst/good.mkv' },
          // Stale report: the target it names is already gone. This item fails,
          // but must not abort the first.
          { source: '/stale.mkv', resolution: 'replace', targetPath: '/dst/vanished.mkv' },
        ],
      });
      expect(res.succeeded).toBe(1);
      expect(res.failed).toBe(1);
      expect(res.results[1].message).toMatch(/no longer exists/i);
    });
  });

  describe('file operations announce themselves', () => {
    /*
     * The seam that keeps the database honest. Files cannot call into media —
     * media already depends on files, so that would be a cycle — so a mover
     * says what it did and media follows.
     *
     * Before this, consistency meant every author of a file operation
     * remembering to update five tables. The rename engine forgot for as long
     * as it existed; the file manager never did it at all.
     */
    it('publishes a move when a file is renamed', async () => {
      await writeFile(join(root, 'a.mkv'), 'video');
      await svc.rename({ path: 'a.mkv', newName: 'b.mkv' } as never);
      const events = bus.publish.mock.calls.map((c) => c[0] as any);
      const moved = events.find((e) => e.eventKey === 'file.moved');
      expect(moved).toBeDefined();
      expect(moved.payload.from).toContain('a.mkv');
      expect(moved.payload.to).toContain('b.mkv');
    });

    it('never announces a move that did not happen', () => {
      // A rename onto the same name is a no-op; announcing it would make every
      // subscriber do pointless work.
      expect((svc as any).announceMove('/x/a.mkv', '/x/a.mkv')).toBeUndefined();
      expect(bus.publish).not.toHaveBeenCalled();
    });
  });

});
