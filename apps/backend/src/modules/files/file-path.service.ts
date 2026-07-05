import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs, constants as fsc } from 'node:fs';
import * as path from 'node:path';
import { PathSafety, SYSTEM_DIRS } from './path-safety';
import { SettingsService } from '../settings/settings.module';

/** Request context threaded into audit entries for file operations. */
export interface FileOpContext {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
}

/** Settings key holding the admin-configured (narrowed) default browse root. */
export const DEFAULT_ROOT_PATH_KEY = 'fileManager.defaultRootPath';

export interface RootInfo {
  /** Effective absolute root the browser is confined to right now. */
  root: string;
  /** The admin-configured value (null = using the env default). */
  configured: string | null;
  /** The ops-controlled hard boundary (FILE_MANAGER_ROOTS). */
  hardRoots: string[];
  exists: boolean;
  readable: boolean;
  writable: boolean;
}

/**
 * Non-throwing report about an arbitrary caller-supplied path, used by the
 * "the folder doesn't exist — create it?" save flow. It answers, in one call,
 * both boundary questions (is it inside the ops hard roots / a protected system
 * dir?) and the existence questions (does it exist, is it a directory, can we
 * write to it?) — without asserting, so the UI can decide what to prompt.
 */
export interface PathInspection {
  /** The resolved absolute path. */
  path: string;
  /** Inside FILE_MANAGER_ROOTS (the ops hard boundary). */
  withinHardRoots: boolean;
  /** A protected system directory that may never be targeted. */
  isSystemDir: boolean;
  exists: boolean;
  isDirectory: boolean;
  writable: boolean;
}

/**
 * Injectable holder for the configured {@link PathSafety} so every file-manager
 * service shares one source of truth for the allowed roots. The pure
 * `PathSafety` class stays framework-free for unit testing.
 *
 * Two layers of boundary:
 *  - **hard roots** — `FILE_MANAGER_ROOTS` env (ops-controlled); the browser can
 *    never escape these.
 *  - **default root path** — a DB setting an admin can set to *narrow* browsing
 *    to a subtree inside the hard roots. Applied to `PathSafety` here, so every
 *    existing containment check (browse, create-folder, move, …) honours it.
 */
@Injectable()
export class FilePathService implements OnModuleInit {
  private readonly logger = new Logger(FilePathService.name);
  private readonly envRoots: string[];
  private _safety: PathSafety;

  constructor(
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
  ) {
    this.envRoots = (config.get<string[]>('fileManager.roots') ?? []).map((r) =>
      path.resolve(r),
    );
    this._safety = new PathSafety(this.envRoots);
  }

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /** Delegated per-call so a refresh() propagates to every consumer. */
  get safety(): PathSafety {
    return this._safety;
  }

  /** The ops-controlled outer boundary. */
  get hardRoots(): string[] {
    return this.envRoots;
  }

  private withinHardRoots(abs: string): boolean {
    return this.envRoots.some((r) => abs === r || abs.startsWith(r + path.sep));
  }

  private isSystemDir(abs: string): boolean {
    return SYSTEM_DIRS.includes(path.resolve(abs));
  }

  /**
   * Assert a caller-supplied path is a normal path inside the ops hard roots
   * (FILE_MANAGER_ROOTS) — used to constrain torrent save/move destinations to
   * the allowed storage area. Returns the resolved absolute path.
   */
  assertWithinHardRoots(requested: string): string {
    if (typeof requested !== 'string' || !requested.trim()) {
      throw new BadRequestException('A path is required.');
    }
    const abs = path.resolve(requested.trim());
    if (this.isSystemDir(abs)) {
      throw new ForbiddenException('Path is a protected system directory.');
    }
    if (!this.withinHardRoots(abs)) {
      throw new ForbiddenException(
        `Path is outside the allowed storage roots (${this.envRoots.join(', ')}).`,
      );
    }
    return abs;
  }

  /**
   * Inspect a caller-supplied path without throwing. Reports containment within
   * the hard roots plus on-disk state so the frontend can validate a typed path
   * and offer to create it when it's allowed but missing.
   */
  async inspect(requested: string): Promise<PathInspection> {
    if (typeof requested !== 'string' || !requested.trim()) {
      throw new BadRequestException('A path is required.');
    }
    const abs = path.resolve(requested.trim());
    const isSystemDir = this.isSystemDir(abs);
    const withinHardRoots = this.withinHardRoots(abs);
    let exists = false;
    let isDirectory = false;
    let writable = false;
    try {
      const st = await fs.stat(abs);
      exists = true;
      isDirectory = st.isDirectory();
    } catch {
      exists = false;
    }
    if (exists) {
      writable = await fs
        .access(abs, fsc.W_OK)
        .then(() => true)
        .catch(() => false);
    }
    return { path: abs, withinHardRoots, isSystemDir, exists, isDirectory, writable };
  }

  /**
   * Create a directory (recursively) after asserting it is a normal path inside
   * the ops hard roots and not a protected system directory. Idempotent — a
   * pre-existing directory is fine. Returns the fresh inspection.
   */
  async ensureDirectory(requested: string): Promise<PathInspection> {
    const abs = this.assertWithinHardRoots(requested);
    const existing = await fs.stat(abs).catch(() => null);
    if (existing && !existing.isDirectory()) {
      throw new BadRequestException('That path already exists and is not a directory.');
    }
    try {
      await fs.mkdir(abs, { recursive: true });
    } catch (err) {
      throw this.translateMkdirError(abs, err);
    }
    return this.inspect(abs);
  }

  /**
   * Turn a raw `mkdir` failure into an actionable HTTP error instead of letting
   * it surface as an opaque 500 "Internal server error". The common case is a
   * root the server user cannot create — e.g. the default `/downloads` root when
   * `FILE_MANAGER_ROOTS` is unset — which fails with EACCES at the filesystem
   * root.
   */
  private translateMkdirError(abs: string, err: unknown): Error {
    const code = (err as NodeJS.ErrnoException)?.code;
    switch (code) {
      case 'EACCES':
      case 'EPERM':
        return new ForbiddenException(
          `Permission denied creating "${abs}". The server does not have write access there — ` +
            `check the folder's ownership/permissions, or point the storage root (FILE_MANAGER_ROOTS) at a writable directory.`,
        );
      case 'EROFS':
        return new ForbiddenException(
          `Cannot create "${abs}" — it lives on a read-only filesystem.`,
        );
      case 'ENOSPC':
        return new BadRequestException(
          `Cannot create "${abs}" — the disk is full (no space left).`,
        );
      case 'ENOTDIR':
        return new BadRequestException(
          `Cannot create "${abs}" — one of the parent path segments is a file, not a directory.`,
        );
      case 'ENAMETOOLONG':
        return new BadRequestException(`Cannot create "${abs}" — the path is too long.`);
      default: {
        const msg = (err as Error)?.message ?? String(err);
        this.logger.error(`mkdir failed for "${abs}": ${msg}`);
        return new BadRequestException(`Could not create "${abs}": ${msg}`);
      }
    }
  }

  /** Rebuild PathSafety from the DB setting, narrowed within the env roots. */
  async refresh(): Promise<void> {
    let configured: string | undefined;
    try {
      configured = await this.settings.get<string>(DEFAULT_ROOT_PATH_KEY);
    } catch (err) {
      this.logger.warn(
        `Could not read ${DEFAULT_ROOT_PATH_KEY}: ${(err as Error).message}`,
      );
    }
    if (configured && configured.trim()) {
      const abs = path.resolve(configured.trim());
      if (this.withinHardRoots(abs) && !this.isSystemDir(abs)) {
        this._safety = new PathSafety([abs]);
        return;
      }
      this.logger.warn(
        `Configured default root "${configured}" is outside FILE_MANAGER_ROOTS; ignoring.`,
      );
    }
    this._safety = new PathSafety(this.envRoots);
  }

  /** Metadata about the current effective root (for the Settings UI). */
  async rootInfo(): Promise<RootInfo> {
    const root = this._safety.listRoots()[0] ?? this.envRoots[0] ?? '';
    const configuredRaw = await this.settings
      .get<string>(DEFAULT_ROOT_PATH_KEY)
      .catch(() => undefined);
    const configured =
      configuredRaw && configuredRaw.trim() ? configuredRaw.trim() : null;

    let exists = false;
    let readable = false;
    let writable = false;
    try {
      exists = (await fs.stat(root)).isDirectory();
    } catch {
      exists = false;
    }
    if (exists) {
      readable = await fs
        .access(root, fsc.R_OK)
        .then(() => true)
        .catch(() => false);
      writable = await fs
        .access(root, fsc.W_OK)
        .then(() => true)
        .catch(() => false);
    }
    return { root, configured, hardRoots: this.envRoots, exists, readable, writable };
  }

  /**
   * Set the admin-configured default root. Must be an absolute directory inside
   * the env hard roots (ops boundary), not a system directory, and existing +
   * readable. Persists the setting and refreshes PathSafety. Returns the
   * previous value + new state for auditing.
   */
  async setDefaultRoot(
    requested: string,
  ): Promise<{ previous: string | null; rootInfo: RootInfo }> {
    if (typeof requested !== 'string' || !requested.trim()) {
      throw new BadRequestException('A root path is required.');
    }
    const abs = path.resolve(requested.trim());
    if (this.isSystemDir(abs)) {
      throw new BadRequestException('That path is a protected system directory.');
    }
    if (!this.withinHardRoots(abs)) {
      throw new BadRequestException(
        `Root path must be within the server's configured storage roots (${this.envRoots.join(
          ', ',
        )}).`,
      );
    }
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      throw new BadRequestException('That path does not exist.');
    }
    if (!st.isDirectory()) {
      throw new BadRequestException('That path is not a directory.');
    }
    const readable = await fs
      .access(abs, fsc.R_OK)
      .then(() => true)
      .catch(() => false);
    if (!readable) {
      throw new BadRequestException('The server cannot read that path.');
    }

    const previousRaw = await this.settings
      .get<string>(DEFAULT_ROOT_PATH_KEY)
      .catch(() => undefined);
    const previous = previousRaw && previousRaw.trim() ? previousRaw.trim() : null;

    await this.settings.set(DEFAULT_ROOT_PATH_KEY, abs);
    await this.refresh();
    return { previous, rootInfo: await this.rootInfo() };
  }
}
