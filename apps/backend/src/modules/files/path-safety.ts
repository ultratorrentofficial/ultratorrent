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

  /**
   * Whether clients address files by ABSOLUTE path rather than root-relative.
   *
   * With one root the relative form is a complete, unambiguous encoding, and it
   * is what every existing deployment — and every trash `originalPath` already
   * stored — uses. With several roots it is not: `/TV Shows` names a directory
   * under *each* root and nothing in the string says which was meant. Rebasing
   * it onto `roots[0]` does not resolve that ambiguity, it hides it, silently
   * serving the first root's copy (or 500ing on ENOENT when only the second
   * root has the folder). So a multi-root deployment switches to absolute paths
   * on the wire, which {@link toRelative} emits and this method accepts.
   */
  get usesAbsolutePaths(): boolean {
    return this.normalizedRoots().length > 1;
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
    const contains = (target: string) =>
      roots.some((root) => target === root || target.startsWith(root + path.sep));
    if (roots.length > 1) {
      /*
       * Absolute form — see `usesAbsolutePaths`. `path.resolve('')` would yield
       * the process cwd, so the empty/virtual-root request is normalised to '/'
       * and then fails containment like any other outside path; the virtual
       * root above several roots is not a directory and is answered by
       * `FilesService.browse` before it ever reaches here.
       */
      const target = path.resolve(requested || '/');
      if (!contains(target)) {
        throw new ForbiddenException('Path is outside the allowed roots');
      }
      return target;
    }
    const target = path.resolve(roots[0], requested.replace(/^\/+/, ''));
    if (!contains(target)) {
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

  /**
   * `absPath` relative to a SPECIFIC root, always `/`-prefixed.
   *
   * Independent of how many roots exist, which is what makes it the right form
   * to STORE. Trash and quarantine record the root an item came from and rebase
   * the saved path onto *that* root to restore it, so they need a path whose
   * meaning does not move: {@link toRelative} is the CLIENT-facing form and
   * switches to absolute once there are several roots, which would make a
   * restore resolve to `<root>/<root>/…`. The two coincide under a single root,
   * which is why storing the client form worked until a second root appeared.
   */
  relativeToRoot(root: string, absPath: string): string {
    const base = path.resolve(root);
    const resolved = path.resolve(absPath);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new ForbiddenException('Path is outside the given root');
    }
    const rel = path.relative(base, resolved);
    return '/' + rel.split(path.sep).filter(Boolean).join('/');
  }

  /**
   * Convert an absolute path to the form clients address it by — root-relative
   * under a single root, absolute when there are several (see
   * {@link usesAbsolutePaths}). Always `/`-prefixed either way, and always
   * accepted back by {@link resolveLogical}.
   *
   * Refuses a path no root contains rather than rebasing it against `roots[0]`.
   * That fallback used to emit a `..`-escaping string (`/../TV/show.mkv`) which
   * looked like a valid relative path, survived being passed around, and only
   * failed containment when something resolved it back — reporting the boundary
   * error far from the mistake that caused it.
   */
  toRelative(absPath: string): string {
    const resolved = path.resolve(absPath);
    const root = this.rootFor(resolved);
    if (!root) {
      throw new ForbiddenException('Path is outside the allowed roots');
    }
    if (this.usesAbsolutePaths) {
      return resolved;
    }
    const rel = path.relative(root, resolved);
    return '/' + rel.split(path.sep).filter(Boolean).join('/');
  }
}
