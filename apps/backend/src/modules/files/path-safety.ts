import { ForbiddenException, BadRequestException } from '@nestjs/common';
import * as path from 'node:path';
import { realpath } from 'node:fs/promises';

/** Name of the per-root trash directory used by soft-delete (Trash mode). */
export const TRASH_DIR_NAME = '.ultratorrent-trash';

/**
 * Absolute paths that must NEVER be operated on, even if a misconfigured root
 * were to contain them. Deletion/move targets are checked against this list and
 * the filesystem root in addition to the allowed-root containment check.
 */
export const SYSTEM_DIRS = [
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/srv',
  '/sys',
  '/usr',
  '/var',
  '/home',
  '/opt',
  '/mnt',
  '/media',
].map((p) => path.resolve(p));

/** Reject filenames that contain separators, null bytes, or `.`/`..`. */
export function assertSafeName(name: string, label = 'name'): void {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > 255 ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name === '.' ||
    name === '..'
  ) {
    throw new BadRequestException(`Invalid ${label}`);
  }
}

/**
 * Resolves a user-supplied path against a set of allowed roots and guarantees
 * the result stays inside one of them — defeating `../` traversal and symlink
 * escapes. Every file-manager operation MUST route through this.
 */
export class PathSafety {
  constructor(private readonly roots: string[]) {}

  private normalizedRoots(): string[] {
    return this.roots.map((r) => path.resolve(r));
  }

  /** Resolve without touching the filesystem (for create/destination paths). */
  resolveLogical(requested: string): string {
    if (typeof requested !== 'string' || requested.includes('\0')) {
      throw new BadRequestException('Invalid path');
    }
    const roots = this.normalizedRoots();
    if (roots.length === 0) {
      throw new ForbiddenException('No file-manager roots configured');
    }
    const target = path.resolve(roots[0], requested.replace(/^\/+/, ''));
    const contained = roots.some(
      (root) => target === root || target.startsWith(root + path.sep),
    );
    if (!contained) {
      throw new ForbiddenException('Path is outside the allowed roots');
    }
    return target;
  }

  /** Resolve and verify against the real (symlink-resolved) path on disk. */
  async resolveExisting(requested: string): Promise<string> {
    const logical = this.resolveLogical(requested);
    let real: string;
    try {
      real = await realpath(logical);
    } catch {
      // Path does not exist yet — fall back to the logical check.
      return logical;
    }
    const roots = await Promise.all(
      this.normalizedRoots().map((r) => realpath(r).catch(() => r)),
    );
    const contained = roots.some(
      (root) => real === root || real.startsWith(root + path.sep),
    );
    if (!contained) {
      throw new ForbiddenException('Resolved path escapes the allowed roots');
    }
    return real;
  }

  listRoots(): string[] {
    return this.normalizedRoots();
  }

  /**
   * Validate that an ALREADY-ABSOLUTE path is contained in a root and return it.
   * Unlike {@link resolveLogical}, this does not strip/re-base a leading slash —
   * use it for paths derived from an already-resolved absolute path (e.g. a
   * sibling for rename), never for raw client input.
   */
  ensureContained(absPath: string): string {
    if (typeof absPath !== 'string' || absPath.includes('\0')) {
      throw new BadRequestException('Invalid path');
    }
    const resolved = path.resolve(absPath);
    if (!this.rootFor(resolved)) {
      throw new ForbiddenException('Path is outside the allowed roots');
    }
    return resolved;
  }

  /** The configured root that contains `absPath`, or undefined. */
  rootFor(absPath: string): string | undefined {
    const resolved = path.resolve(absPath);
    return this.normalizedRoots().find(
      (root) => resolved === root || resolved.startsWith(root + path.sep),
    );
  }

  /** True if `absPath` is itself one of the configured roots. */
  isRoot(absPath: string): boolean {
    const resolved = path.resolve(absPath);
    return this.normalizedRoots().some((root) => root === resolved);
  }

  /** True if `absPath` lives inside any root's `.ultratorrent-trash` directory. */
  isInsideTrash(absPath: string): boolean {
    const resolved = path.resolve(absPath);
    return this.normalizedRoots().some((root) => {
      const trash = path.join(root, TRASH_DIR_NAME);
      return resolved === trash || resolved.startsWith(trash + path.sep);
    });
  }

  /**
   * Guard a destructive target (delete/move-source). Beyond root containment,
   * forbids deleting a configured root, the filesystem root, or any known
   * system directory.
   */
  assertDeletable(absPath: string): void {
    const resolved = path.resolve(absPath);
    if (resolved === path.parse(resolved).root) {
      throw new ForbiddenException('Refusing to operate on the filesystem root');
    }
    if (this.isRoot(resolved)) {
      throw new ForbiddenException('Refusing to delete a configured storage root');
    }
    if (SYSTEM_DIRS.includes(resolved)) {
      throw new ForbiddenException('Refusing to operate on a system directory');
    }
  }

  /** Convert an absolute path to its root-relative form (always `/`-prefixed). */
  toRelative(absPath: string): string {
    const root = this.rootFor(absPath) ?? this.normalizedRoots()[0];
    if (!root) return absPath;
    const rel = path.relative(root, path.resolve(absPath));
    return '/' + rel.split(path.sep).filter(Boolean).join('/');
  }
}
