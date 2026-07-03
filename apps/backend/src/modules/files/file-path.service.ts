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
