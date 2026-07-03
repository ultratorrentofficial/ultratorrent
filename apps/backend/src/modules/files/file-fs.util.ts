import {
  cp,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';

/** True if a path exists on disk. */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** stat or null (never throws). */
export async function statSafe(p: string): Promise<Stats | null> {
  return stat(p).catch(() => null);
}

/** Recursive byte size of a file or directory. */
export async function computeSize(p: string): Promise<number> {
  const info = await statSafe(p);
  if (!info) return 0;
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  const entries = await readdir(p, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const e of entries) {
    total += await computeSize(path.join(p, e.name));
  }
  return total;
}

/** Recursive count of files + folders contained in a directory (excludes itself). */
export async function countItems(p: string): Promise<number> {
  const info = await statSafe(p);
  if (!info || !info.isDirectory()) return 0;
  const entries = await readdir(p, { withFileTypes: true }).catch(() => []);
  let count = entries.length;
  for (const e of entries) {
    if (e.isDirectory()) count += await countItems(path.join(p, e.name));
  }
  return count;
}

/** Copy a file or directory (recursive). Caller validates src/dest containment. */
export async function copyRecursive(
  src: string,
  dest: string,
  overwrite: boolean,
): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(src, dest, {
    recursive: true,
    force: overwrite,
    errorOnExist: !overwrite,
  });
}

/**
 * Move a file or directory. Uses rename; falls back to copy+remove across
 * devices (EXDEV), which can happen when a destination root is a different
 * mount than the source root.
 */
export async function moveRecursive(
  src: string,
  dest: string,
  overwrite: boolean,
): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    await rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await cp(src, dest, { recursive: true, force: overwrite, errorOnExist: !overwrite });
      await rm(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}
