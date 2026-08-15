import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { watch, type FSWatcher } from 'node:fs';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MediaScannerService, isIgnoredScanDir } from './media-scanner.service';
import { coalesceScanTargets } from './domain/watch-coalesce';

/** Quiet period before a burst is answered. Long enough that a copy finishes. */
const DEBOUNCE_MS = 10_000;
/**
 * Watches one library may hold.
 *
 * inotify watches come from a per-uid budget shared with everything else running
 * as that user — on this platform, the media server. Running out is not a quiet
 * degradation: it is what starved a transcoder here once already. A per-library
 * ceiling keeps one enormous tree from consuming the budget on its own.
 */
const MAX_WATCHES_PER_LIBRARY = 30_000;

export interface LibraryWatchStatus {
  libraryId: string;
  name: string;
  watching: boolean;
  watchCount: number;
  /** Why watching stopped or never started; null while healthy. */
  degradedReason: string | null;
}

/**
 * Watch library trees and rescan a folder the moment its contents change.
 *
 * The gap this closes: a file copied into a library folder was invisible to
 * UltraTorrent until something scanned, while the media server — which watches
 * the filesystem — listed it within seconds. On the live install every library
 * had auto-scan unset, so "until something scanned" meant indefinitely, and a
 * film sat in a library folder for two days visible in Plex and absent here.
 *
 * **One watch per directory, because Linux has no recursive watch.**
 * `fs.watch({recursive:true})` is macOS and Windows only, so a real media tree
 * costs one watch per folder — around 21,600 on the host this was built for.
 * That is affordable but not free, and it is shared with the media server, so:
 * a per-library ceiling, and an inotify exhaustion (`ENOSPC`/`EMFILE`) stops
 * watching that library and SAYS SO rather than silently watching nothing. A
 * watcher that has quietly died is worse than no watcher, because the operator
 * believes changes are being noticed.
 *
 * Scans are debounced and coalesced ({@link coalesceScanTargets}) — a torrent
 * writing a large file fires hundreds of events, and reacting per event would
 * scan the same folder hundreds of times while competing with the write.
 */
@Injectable()
export class MediaLibraryWatcherService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MediaLibraryWatcherService.name);
  /** libraryId → (directory → watcher). */
  private readonly watchers = new Map<string, Map<string, FSWatcher>>();
  /** libraryId → directories changed since the last sweep. */
  private readonly pending = new Map<string, Set<string>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly degraded = new Map<string, string>();
  private readonly roots = new Map<string, { name: string; path: string }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly scanner: MediaScannerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Bootstrap, not module init: the scanner's own dependencies must be live
    // before anything can fire a scan at it.
    await this.startupScans();
    await this.syncWatchers();
  }

  onModuleDestroy(): void {
    for (const [, dirs] of this.watchers) for (const [, w] of dirs) w.close();
    for (const [, t] of this.timers) clearTimeout(t);
    this.watchers.clear();
    this.timers.clear();
  }

  /** Live state, for the UI — a watcher's health is not a config value. */
  status(): LibraryWatchStatus[] {
    return [...this.roots.entries()].map(([libraryId, meta]) => ({
      libraryId,
      name: meta.name,
      watching: (this.watchers.get(libraryId)?.size ?? 0) > 0,
      watchCount: this.watchers.get(libraryId)?.size ?? 0,
      degradedReason: this.degraded.get(libraryId) ?? null,
    }));
  }

  /**
   * Catch up on anything that changed while the process was down.
   *
   * Run one library at a time rather than in parallel: a boot-time scan of
   * several libraries at once is the heaviest thing this application does, and
   * doing it while everything else is also starting is how a NAS falls over.
   */
  private async startupScans(): Promise<void> {
    const libraries = await this.prisma.mediaLibrary
      .findMany({ where: { isEnabled: true, scanOnStartup: true } })
      .catch(() => []);
    for (const library of libraries) {
      try {
        const summary = await this.scanner.scanLibrary(library.id);
        this.logger.log(
          `Startup scan of ${library.name}: ${summary.scanned} scanned, `
            + `${summary.added} added, ${summary.removed} removed`,
        );
      } catch (err) {
        this.logger.warn(`Startup scan of ${library.name} failed: ${(err as Error).message}`);
      }
    }
  }

  /** Start watchers for libraries that want them; stop the rest. */
  async syncWatchers(): Promise<void> {
    const libraries = await this.prisma.mediaLibrary
      .findMany({ where: { isEnabled: true } })
      .catch(() => []);

    const wanted = new Set(libraries.filter((l) => l.watchEnabled).map((l) => l.id));
    for (const id of [...this.watchers.keys()]) if (!wanted.has(id)) this.stop(id);

    for (const library of libraries) {
      if (!library.watchEnabled || this.watchers.has(library.id)) continue;
      this.roots.set(library.id, { name: library.name, path: library.path });
      await this.start(library.id, library.name, library.path);
    }
  }

  private stop(libraryId: string): void {
    for (const [, w] of this.watchers.get(libraryId) ?? []) w.close();
    this.watchers.delete(libraryId);
    this.degraded.delete(libraryId);
  }

  private async start(libraryId: string, name: string, root: string): Promise<void> {
    const dirs = new Map<string, FSWatcher>();
    this.watchers.set(libraryId, dirs);
    this.degraded.delete(libraryId);
    const added = await this.watchTree(libraryId, root, root, dirs);
    if (added < 0) return; // degraded; watchTree has already reported why
    this.logger.log(`Watching ${name}: ${dirs.size} directories`);
  }

  /**
   * Add a watch for `dir` and everything beneath it.
   *
   * Returns -1 when the library was degraded mid-walk, so the caller stops
   * rather than logging a success for a partial tree.
   */
  private async watchTree(
    libraryId: string,
    root: string,
    dir: string,
    dirs: Map<string, FSWatcher>,
  ): Promise<number> {
    if (this.degraded.has(libraryId)) return -1;
    if (dirs.size >= MAX_WATCHES_PER_LIBRARY) {
      this.degrade(libraryId, `watch ceiling reached (${MAX_WATCHES_PER_LIBRARY} directories)`);
      return -1;
    }
    if (!dirs.has(dir) && !this.addWatch(libraryId, root, dir, dirs)) return -1;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return dirs.size; // unreadable subtree is not a reason to abandon the rest
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || isIgnoredScanDir(entry.name)) continue;
      const child = await this.watchTree(libraryId, root, path.join(dir, entry.name), dirs);
      if (child < 0) return -1;
    }
    return dirs.size;
  }

  private addWatch(
    libraryId: string,
    root: string,
    dir: string,
    dirs: Map<string, FSWatcher>,
  ): boolean {
    try {
      const watcher = watch(dir, (_event, filename) => {
        /*
         * The event names a child; the DIRECTORY is what gets rescanned, since
         * that is the unit a scan works in. A new subdirectory also needs its
         * own watch — created folders are how a season or a film arrives.
         */
        this.queue(libraryId, root, dir);
        if (filename) void this.maybeWatchNewDir(libraryId, root, path.join(dir, String(filename)), dirs);
      });
      watcher.on('error', (err) => this.onWatchError(libraryId, err));
      dirs.set(dir, watcher);
      return true;
    } catch (err) {
      this.onWatchError(libraryId, err as Error);
      return false;
    }
  }

  private async maybeWatchNewDir(
    libraryId: string,
    root: string,
    candidate: string,
    dirs: Map<string, FSWatcher>,
  ): Promise<void> {
    if (dirs.has(candidate) || this.degraded.has(libraryId)) return;
    try {
      const entries = await readdir(candidate, { withFileTypes: true });
      if (isIgnoredScanDir(path.basename(candidate))) return;
      if (!this.addWatch(libraryId, root, candidate, dirs)) return;
      for (const e of entries) {
        if (e.isDirectory()) await this.maybeWatchNewDir(libraryId, root, path.join(candidate, e.name), dirs);
      }
    } catch {
      // Not a directory, or gone again already. Either is ordinary.
    }
  }

  /**
   * inotify exhaustion is reported, never swallowed.
   *
   * `ENOSPC` here does not mean the disk is full — it is the kernel refusing
   * another watch. Left silent, the library simply stops noticing changes while
   * the UI still says it is watched.
   */
  private onWatchError(libraryId: string, err: Error): void {
    const code = (err as NodeJS.ErrnoException).code;
    const reason = code === 'ENOSPC' || code === 'EMFILE'
      ? `out of inotify watches (${code}) — raise fs.inotify.max_user_watches or use an interval instead`
      : `watch error: ${err.message}`;
    this.degrade(libraryId, reason);
  }

  private degrade(libraryId: string, reason: string): void {
    if (this.degraded.has(libraryId)) return;
    this.degraded.set(libraryId, reason);
    const name = this.roots.get(libraryId)?.name ?? libraryId;
    this.logger.error(`Stopped watching ${name}: ${reason}`);
    this.stopWatchersOnly(libraryId);
  }

  /** Close the watchers but keep the degraded reason for the status endpoint. */
  private stopWatchersOnly(libraryId: string): void {
    for (const [, w] of this.watchers.get(libraryId) ?? []) w.close();
    this.watchers.set(libraryId, new Map());
  }

  /** Record a changed directory and (re)arm the quiet period. */
  private queue(libraryId: string, root: string, dir: string): void {
    const set = this.pending.get(libraryId) ?? new Set<string>();
    set.add(dir);
    this.pending.set(libraryId, set);

    const existing = this.timers.get(libraryId);
    if (existing) clearTimeout(existing);
    this.timers.set(libraryId, setTimeout(() => void this.flush(libraryId, root), DEBOUNCE_MS));
  }

  private async flush(libraryId: string, root: string): Promise<void> {
    this.timers.delete(libraryId);
    const dirs = this.pending.get(libraryId);
    this.pending.delete(libraryId);
    if (!dirs?.size) return;

    for (const target of coalesceScanTargets(dirs, { root })) {
      try {
        const summary = await this.scanner.scanLibrary(libraryId, undefined, target);
        if (summary.added || summary.removed || summary.updated) {
          this.logger.log(
            `Watched change in ${path.basename(target)}: `
              + `${summary.added} added, ${summary.updated} updated, ${summary.removed} removed`,
          );
        }
      } catch (err) {
        this.logger.warn(`Watched scan of ${target} failed: ${(err as Error).message}`);
      }
    }
  }
}
