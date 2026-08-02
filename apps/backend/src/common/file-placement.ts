import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, link, lstat, rename, symlink } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The destination is already occupied, so nothing was placed.
 *
 * A distinct type because this is the one failure a caller may want to read
 * rather than merely report — it means "there is already a file there", not
 * "the filesystem refused you".
 */
export class DestinationExistsError extends Error {
  readonly code = 'EEXIST_DESTINATION';
  constructor(readonly destination: string) {
    super(`Destination already exists, refusing to overwrite: ${destination}`);
    this.name = 'DestinationExistsError';
  }
}

/**
 * Refuse to place anything onto an existing path.
 *
 * `rename(2)` and `copyFile` both silently REPLACE their destination — that is
 * POSIX behaviour, not a bug, and it is why this has to be explicit. A rename
 * whose destination is occupied is not a rename, it is a deletion of whatever
 * was there, and the engine has nothing to restore it from: undo replays the
 * recorded move backwards, so the overwritten file was never recorded at all.
 *
 * `lstat`, not `stat`: a dangling symlink still occupies the name, and writing
 * through it destroys the link the user put there.
 *
 * This is a check-then-act, so a file appearing in the gap would still be
 * overwritten by `rename`. POSIX offers no atomic exclusive rename, and the
 * alternative (link + unlink) fails across devices, which is exactly where
 * `rename_move` operates. The narrower races are closed where the syscall
 * allows it — `COPYFILE_EXCL` for copies, and `link`/`symlink` are exclusive by
 * nature — so only same-device renames carry the window.
 */
export async function assertDestinationFree(dest: string): Promise<void> {
  try {
    await lstat(dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return; // free — the normal case
    throw err; // EACCES and friends are real errors, not "it is free"
  }
  throw new DestinationExistsError(dest);
}

/** The ways one file can be put somewhere else. */
export type PlacementAction = 'rename' | 'move' | 'copy' | 'hardlink' | 'reflink' | 'symlink';

export interface PlacementResult {
  /** What was actually done — not necessarily what was asked for. */
  action: PlacementAction;
  /** True when the requested action was impossible and a fallback ran. */
  fellBack: boolean;
  reason?: string;
}

/**
 * Put one file somewhere else.
 *
 * The single placement primitive for the whole application. It was previously a
 * private method on `MediaService`, which meant the Media Intake engine had a
 * choice between reaching into another service or writing a second copy — and a
 * second copy of "how a file gets moved" is the kind of duplication that
 * diverges quietly until one of them is wrong.
 *
 * It **returns what it actually did**. The distinction matters to intake: a
 * hardlink that fell back to a copy still succeeded, but it consumed the disk
 * space a hardlink would not have, and an audit that recorded "hardlink" would
 * be describing something that did not happen. The renamer ignores the return
 * and keeps its original behaviour exactly.
 *
 * It **never overwrites**. An occupied destination throws
 * {@link DestinationExistsError} and the source is left exactly where it was,
 * so the caller records a failed operation rather than a silent replacement.
 */
export async function placeFile(
  action: PlacementAction,
  src: string,
  dest: string,
): Promise<PlacementResult> {
  // Before any branch: no action here is allowed to consume an existing file,
  // and several of them would.
  await assertDestinationFree(dest);

  switch (action) {
    case 'rename':
    case 'move':
      await rename(src, dest);
      return { action, fellBack: false };

    case 'copy':
      // EXCL rather than the bare copy: the guard above already refused an
      // occupied path, and this closes the gap between that check and this call.
      await copyFile(src, dest, constants.COPYFILE_EXCL);
      return { action: 'copy', fellBack: false };

    case 'hardlink':
      try {
        await link(src, dest);
        return { action: 'hardlink', fellBack: false };
      } catch (err) {
        // Cross-device is the ordinary case for a NAS library, not an error —
        // but the caller is told, because a copy is not a hardlink.
        if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err;
        await copyFile(src, dest, constants.COPYFILE_EXCL);
        return { action: 'copy', fellBack: true, reason: 'hardlink across devices (EXDEV)' };
      }

    case 'reflink':
      try {
        // Node exposes no FICLONE ioctl, so `cp` is the only way without a
        // native binding. `always` is essential: `auto` silently performs a full
        // copy and would make every filesystem look copy-on-write.
        await run('cp', ['--reflink=always', src, dest]);
        return { action: 'reflink', fellBack: false };
      } catch (err) {
        // A reflink that could not clone must not become an overwrite either.
        if (err instanceof DestinationExistsError) throw err;
        await copyFile(src, dest, constants.COPYFILE_EXCL);
        return {
          action: 'copy',
          fellBack: true,
          reason: `reflink unavailable: ${(err as Error).message}`,
        };
      }

    case 'symlink':
      await symlink(src, dest);
      return { action: 'symlink', fellBack: false };

    default:
      throw new Error(`Unsupported placement action: ${action}`);
  }
}
