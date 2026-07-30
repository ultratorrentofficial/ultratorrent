import { execFile } from 'node:child_process';
import { copyFile, link, rename, symlink } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

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
 */
export async function placeFile(
  action: PlacementAction,
  src: string,
  dest: string,
): Promise<PlacementResult> {
  switch (action) {
    case 'rename':
    case 'move':
      await rename(src, dest);
      return { action, fellBack: false };

    case 'copy':
      await copyFile(src, dest);
      return { action: 'copy', fellBack: false };

    case 'hardlink':
      try {
        await link(src, dest);
        return { action: 'hardlink', fellBack: false };
      } catch (err) {
        // Cross-device is the ordinary case for a NAS library, not an error —
        // but the caller is told, because a copy is not a hardlink.
        if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err;
        await copyFile(src, dest);
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
        await copyFile(src, dest);
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
