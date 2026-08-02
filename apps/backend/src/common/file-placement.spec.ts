import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DestinationExistsError, placeFile } from './file-placement';

/**
 * Placement must never consume a file that is already there.
 *
 * `rename(2)` and `copyFile` REPLACE their destination — POSIX behaviour, not a
 * bug — which made every relocating action a silent deletion whenever two files
 * resolved to the same name. That is unrecoverable in this application: undo
 * replays recorded moves backwards, so a file destroyed by an overwrite was
 * never recorded and cannot be restored.
 *
 * Real filesystem, no mocks: the whole point is what the syscalls do.
 */
describe('placeFile — refuses to overwrite', () => {
  let dir: string;
  let src: string;
  let dest: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'placement-'));
    src = path.join(dir, 'source.mkv');
    dest = path.join(dir, 'dest.mkv');
    await writeFile(src, 'THE SOURCE');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each(['rename', 'move', 'copy', 'hardlink', 'reflink', 'symlink'] as const)(
    'refuses to place a %s onto an existing file, and leaves BOTH intact',
    async (action) => {
      await writeFile(dest, 'THE FILE ALREADY THERE');

      await expect(placeFile(action, src, dest)).rejects.toBeInstanceOf(DestinationExistsError);

      // The occupant is untouched…
      expect(await readFile(dest, 'utf8')).toBe('THE FILE ALREADY THERE');
      // …and the source is still where it was, so the caller can report a
      // failure rather than having lost a file to it.
      expect(await readFile(src, 'utf8')).toBe('THE SOURCE');
    },
  );

  it('names the destination in the error, because the operator has to find it', async () => {
    await writeFile(dest, 'occupied');
    await expect(placeFile('rename', src, dest)).rejects.toMatchObject({
      code: 'EEXIST_DESTINATION',
      destination: dest,
    });
  });

  it('treats a DANGLING SYMLINK as occupied', async () => {
    // lstat, not stat: the link still owns the name, and writing through it
    // destroys what the user put there.
    await symlink(path.join(dir, 'nowhere.mkv'), dest);
    await expect(placeFile('rename', src, dest)).rejects.toBeInstanceOf(DestinationExistsError);
    expect(await readFile(src, 'utf8')).toBe('THE SOURCE');
  });

  it('treats a DIRECTORY at the destination as occupied', async () => {
    await mkdir(dest);
    await expect(placeFile('copy', src, dest)).rejects.toBeInstanceOf(DestinationExistsError);
    expect(await readFile(src, 'utf8')).toBe('THE SOURCE');
  });
});

/**
 * The guard must not become "placement no longer works". Every action still has
 * to do its job when the destination is genuinely free.
 */
describe('placeFile — still places when the destination is free', () => {
  let dir: string;
  let src: string;
  let dest: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'placement-ok-'));
    src = path.join(dir, 'source.mkv');
    dest = path.join(dir, 'dest.mkv');
    await writeFile(src, 'PAYLOAD');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('renames', async () => {
    const r = await placeFile('rename', src, dest);
    expect(r).toEqual({ action: 'rename', fellBack: false });
    expect(await readFile(dest, 'utf8')).toBe('PAYLOAD');
    await expect(stat(src)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('copies, leaving the source', async () => {
    const r = await placeFile('copy', src, dest);
    expect(r).toEqual({ action: 'copy', fellBack: false });
    expect(await readFile(dest, 'utf8')).toBe('PAYLOAD');
    expect(await readFile(src, 'utf8')).toBe('PAYLOAD');
  });

  it('hardlinks', async () => {
    const r = await placeFile('hardlink', src, dest);
    expect(r.action).toBe('hardlink');
    expect((await stat(dest)).ino).toBe((await stat(src)).ino);
  });

  it('symlinks', async () => {
    const r = await placeFile('symlink', src, dest);
    expect(r).toEqual({ action: 'symlink', fellBack: false });
    expect(await readFile(dest, 'utf8')).toBe('PAYLOAD');
  });

  it('reflinks, or falls back to a copy on a filesystem without it', async () => {
    const r = await placeFile('reflink', src, dest);
    expect(['reflink', 'copy']).toContain(r.action);
    expect(await readFile(dest, 'utf8')).toBe('PAYLOAD');
  });
});
