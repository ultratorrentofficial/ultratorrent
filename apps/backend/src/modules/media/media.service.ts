import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  mkdir,
  rename,
  copyFile,
  link,
  symlink,
  stat,
  readdir,
  realpath,
  unlink,
  rmdir,
} from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { paginate, parsePage } from '../../common/pagination';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { SettingsService } from '../settings/settings.module';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from './media-metadata.service';
import {
  buildRenamePlan,
  CleanupRules,
  DEFAULT_CLEANUP_RULES,
  MediaFileInput,
  Preset,
  PRESET_TEMPLATES,
  RenameMode,
  RenamePlan,
} from './media-renamer';
import {
  LocalMetadataProvider,
  MediaMetadataProvider,
  TmdbMetadataProvider,
} from './metadata-provider';

export interface RenameRequest {
  hash?: string;
  engineId?: string;
  path?: string; // ad-hoc filesystem path (file or folder) under an allowed root
  preset?: Preset;
  mode?: RenameMode;
  libraryPath?: string;
  template?: string;
  /**
   * Override the name parsed for show/movie identity (title, season, episode).
   * The caller supplies the already-identified name (e.g. `"Breaking Bad S01E01
   * 1080p.mkv"`) so a bare filename like `S01E01.mkv` still resolves its series
   * title + metadata. Files are still gathered from `path`/`hash` as usual.
   */
  sourceName?: string;
  /**
   * Human-friendly media name (e.g. `"9-1-1 (2018)"`) for activity/audit
   * surfaces. Callers that already know the identified title+year pass it so the
   * dashboard's Recent activity can read "Renamed media for 9-1-1 (2018)" rather
   * than a bare "Media rename". Purely cosmetic — it never affects the plan.
   */
  label?: string;
  /**
   * Build the plan under the real `mode` but do NOT touch disk — a faithful
   * preview. Unlike `mode: 'preview'` (which changes destination resolution,
   * e.g. re-rooting an in-place move under the library instead of reusing the
   * file's existing show folder), this keeps the exact destinations the execute
   * would produce, so a caller can inspect them before committing.
   */
  dryRun?: boolean;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly registry: EngineRegistryService,
    private readonly audit: AuditService,
  ) {}

  presets() {
    return PRESET_TEMPLATES;
  }

  // --- libraries ---------------------------------------------------------
  listLibraries() {
    return this.prisma.mediaLibrary.findMany({ orderBy: { createdAt: 'asc' } });
  }
  createLibrary(data: any) {
    if (!data?.name || !data?.path) {
      throw new BadRequestException('name and path are required');
    }
    return this.prisma.mediaLibrary.create({
      data: {
        name: data.name,
        path: data.path,
        kind: data.kind ?? 'tv',
        preset: data.preset ?? 'plex',
        template: data.template ?? null,
        mode: data.mode ?? 'hardlink',
        isEnabled: data.isEnabled ?? true,
      },
    });
  }
  updateLibrary(id: string, data: any) {
    return this.prisma.mediaLibrary.update({
      where: { id },
      data: {
        name: data.name,
        path: data.path,
        kind: data.kind,
        preset: data.preset,
        template: data.template,
        mode: data.mode,
        isEnabled: data.isEnabled,
      },
    });
  }
  removeLibrary(id: string) {
    return this.prisma.mediaLibrary.delete({ where: { id } });
  }

  history(page?: string, pageSize?: string) {
    return paginate(this.prisma.mediaRenameOperation, { orderBy: { createdAt: 'desc' } }, parsePage(page, pageSize));
  }

  // --- path safety -------------------------------------------------------
  private fileRoots(): string[] {
    return (this.config.get<string[]>('fileManager.roots') ?? []).map((r) =>
      path.resolve(r),
    );
  }

  private async allowedRoots(): Promise<string[]> {
    const libs = await this.prisma.mediaLibrary.findMany({ select: { path: true } });
    return [...this.fileRoots(), ...libs.map((l) => path.resolve(l.path))];
  }

  private assertWithin(absPath: string, roots: string[], label: string): string {
    const resolved = path.resolve(absPath);
    const ok = roots.some(
      (r) => resolved === r || resolved.startsWith(r + path.sep),
    );
    if (!ok) {
      throw new BadRequestException(`${label} is outside allowed directories`);
    }
    return resolved;
  }

  // --- metadata provider -------------------------------------------------
  private async provider(): Promise<MediaMetadataProvider> {
    const key =
      (await this.settings.get<string>('media.tmdbApiKey')) ??
      process.env.TMDB_API_KEY;
    return key ? new TmdbMetadataProvider(key) : new LocalMetadataProvider();
  }

  /**
   * Verify a TMDB API key against the live service. When `apiKey` is provided
   * (the value typed in Settings, possibly unsaved) that is tested; otherwise
   * the saved/env key is used. Never echoes the key back; audited.
   */
  async testTmdbKey(
    apiKey: string | undefined,
    ctx: AuditContext = {},
  ): Promise<{ ok: boolean; message: string }> {
    const supplied = typeof apiKey === 'string' ? apiKey.trim() : '';
    const key =
      supplied ||
      (await this.settings.get<string>('media.tmdbApiKey')) ||
      process.env.TMDB_API_KEY ||
      '';
    let result: { ok: boolean; message: string };
    if (!key) {
      result = { ok: false, message: 'No TMDB API key set — enter or save a key first.' };
    } else {
      result = await new TmdbMetadataProvider(key).verify();
    }
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.tmdb.key_tested',
      objectType: 'setting',
      objectId: 'media.tmdbApiKey',
      result: result.ok ? 'success' : 'failure',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { usedSuppliedKey: Boolean(supplied), message: result.message },
    });
    return result;
  }

  // --- plan building -----------------------------------------------------
  private async gatherTorrentFiles(
    hash: string,
    engineId?: string,
  ): Promise<{ sourceName: string; files: MediaFileInput[] }> {
    const engine = await this.registry.resolve(engineId);
    const torrent = await engine.getTorrent(hash);
    if (!torrent) throw new BadRequestException('Torrent not found');
    const files = await engine.getFiles(hash);
    const base = torrent.savePath;
    return {
      sourceName: torrent.name,
      files: files.map((f) => ({
        path: path.isAbsolute(f.path) ? f.path : path.join(base, f.path),
        size: f.size,
      })),
    };
  }

  private async gatherPathFiles(
    requested: string,
  ): Promise<{ sourceName: string; files: MediaFileInput[] }> {
    const roots = await this.allowedRoots();
    const abs = this.assertWithin(requested, roots, 'path');
    const info = await stat(abs).catch(() => null);
    if (!info) throw new BadRequestException('Path does not exist');
    if (info.isFile()) {
      return { sourceName: path.basename(abs), files: [{ path: abs, size: info.size }] };
    }
    const files: MediaFileInput[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          const s = await stat(full).catch(() => null);
          if (s) files.push({ path: full, size: s.size });
        }
      }
    };
    await walk(abs);
    return { sourceName: path.basename(abs), files };
  }

  async buildPlan(req: RenameRequest): Promise<RenamePlan> {
    const preset: Preset = req.preset ?? 'plex';
    const mode: RenameMode = req.mode ?? 'preview';
    if (!req.libraryPath) throw new BadRequestException('libraryPath is required');

    const gathered = req.hash
      ? await this.gatherTorrentFiles(req.hash, req.engineId)
      : req.path
        ? await this.gatherPathFiles(req.path)
        : (() => {
            throw new BadRequestException('Provide a torrent hash or a path');
          })();
    const files = gathered.files;
    // Prefer a caller-supplied identity name (the already-identified series +
    // SxxEyy) over the bare gathered basename, so metadata resolves even when the
    // filename omits the title.
    const sourceName = req.sourceName?.trim() || gathered.sourceName;

    // Metadata enrichment (best-effort).
    const { parseTorrentName } = await import('./../rss/torrent-name-parser');
    const parsed = parseTorrentName(sourceName);
    const meta = await this.provider()
      .then((p) =>
        p.lookup({
          kind: (parsed.contentType === 'movie'
            ? 'movie'
            : parsed.contentType === 'anime_episode'
              ? 'anime'
              : 'tv') as any,
          title: parsed.title ?? sourceName,
          year: parsed.year,
          season: parsed.season,
          episode: parsed.episode ?? parsed.absoluteEpisode,
        }),
      )
      .catch(() => ({}));

    return buildRenamePlan({
      sourceName,
      files,
      preset,
      mode,
      libraryPath: req.libraryPath,
      template: req.template,
      meta,
      cleanup: await this.getCleanup(),
    });
  }

  // --- cleanup rules -----------------------------------------------------
  /** Read the global junk-cleanup rules (with defaults for any missing field). */
  async getCleanup(): Promise<CleanupRules> {
    const stored = await this.settings.get<Partial<CleanupRules>>('media.cleanup');
    return { ...DEFAULT_CLEANUP_RULES, ...(stored ?? {}) };
  }

  /** Persist the global junk-cleanup rules (merged over current). Audited. */
  async setCleanup(patch: Partial<CleanupRules>, ctx: AuditContext = {}): Promise<CleanupRules> {
    const next: CleanupRules = { ...(await this.getCleanup()), ...patch };
    // Normalize: trim/drop blank patterns + language codes.
    next.deleteGlobs = (next.deleteGlobs ?? []).map((g) => g.trim()).filter(Boolean);
    next.subtitleKeepLanguages = (next.subtitleKeepLanguages ?? [])
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean);
    await this.settings.set('media.cleanup', next);
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.cleanup.updated',
      objectType: 'setting',
      objectId: 'media.cleanup',
      metadata: {
        enabled: next.enabled,
        deleteGlobs: next.deleteGlobs.length,
        keepLanguages: next.subtitleKeepLanguages,
        pruneEmptyDirs: next.pruneEmptyDirs,
        removeLeftoverTorrent: next.removeLeftoverTorrent,
      },
    });
    return next;
  }

  // --- execution ---------------------------------------------------------
  async apply(req: RenameRequest): Promise<{
    applied: number;
    skipped: number;
    failed: number;
    deleted: number;
    plan: RenamePlan;
  }> {
    const plan = await this.buildPlan(req);
    let applied = 0;
    let skipped = 0;
    let failed = 0;
    let deleted = 0;

    if (plan.mode === 'preview' || req.dryRun) {
      return { applied: 0, skipped: plan.items.length, failed: 0, deleted: 0, plan };
    }

    const roots = await this.allowedRoots();
    // The chosen library must itself live under an allowed root.
    this.assertWithin(plan.libraryPath, roots, 'libraryPath');

    // Source folders touched, so we can prune the leftovers after moving.
    const sourceDirs = new Set<string>();

    for (const item of plan.items) {
      // Cleanup deletions: erase junk before/around the moves. Scoped to the
      // allowed roots and resolved through symlinks, exactly like a move source.
      if (item.action === 'delete') {
        try {
          const src = this.assertWithin(item.source, roots, 'source');
          const realSrc = await realpath(src).catch(() => src);
          this.assertWithin(realSrc, roots, 'source');
          sourceDirs.add(path.dirname(realSrc));
          await unlink(realSrc);
          deleted++;
          await this.log(item, plan.mode, 'success', req.hash, null);
        } catch (err) {
          failed++;
          await this.log(item, plan.mode, 'failed', req.hash, (err as Error).message);
          this.logger.warn(`cleanup delete failed: ${(err as Error).message}`);
        }
        continue;
      }

      if (item.skipped || !item.destination) {
        skipped++;
        continue;
      }
      try {
        const src = this.assertWithin(item.source, roots, 'source');
        // Reject symlink escapes from the real source location.
        const realSrc = await realpath(src).catch(() => src);
        this.assertWithin(realSrc, roots, 'source');
        let dest = this.assertWithin(item.destination, roots, 'destination');

        // In-place TV renames land in the show folder's season subdir. Reuse an
        // existing, differently-padded season folder ("Season 8" vs "Season 08")
        // so we never create a second folder for the same season.
        if (plan.mode === 'rename_in_place') {
          dest = this.assertWithin(await this.reuseExistingSeasonDir(dest), roots, 'destination');
        }

        await mkdir(path.dirname(dest), { recursive: true });
        await this.execute(item.action, realSrc, dest);
        sourceDirs.add(path.dirname(realSrc));
        applied++;
        await this.log(item, plan.mode, 'success', req.hash, null);
      } catch (err) {
        failed++;
        await this.log(item, plan.mode, 'failed', req.hash, (err as Error).message);
        this.logger.warn(`rename failed: ${(err as Error).message}`);
      }
    }

    // Post-move tidy (opt-in): stray .torrent + prune now-empty source folders.
    // Only for the relocating modes; never touches a root or a library folder.
    const rules = await this.getCleanup();
    if (rules.enabled && (plan.mode === 'rename_in_place' || plan.mode === 'rename_move')) {
      await this.postMoveCleanup([...sourceDirs], rules, roots);
    }

    // The representative file for the activity feed's "from → to": the first
    // real (non-skip, non-delete) move that actually landed a destination.
    const primary = plan.items.find(
      (i) => i.action !== 'delete' && !i.skipped && i.destination,
    );
    const fromTo = primary?.destination
      ? renameFromTo(primary.source, primary.destination)
      : null;

    await this.audit.record({
      action: 'media.rename',
      result: failed > 0 ? 'failure' : 'success',
      objectType: 'torrent',
      objectId: req.hash,
      metadata: {
        applied,
        skipped,
        failed,
        deleted,
        mode: plan.mode,
        libraryPath: plan.libraryPath,
        ...(req.label ? { name: req.label } : {}),
        ...(fromTo ?? {}),
      },
    });

    return { applied, skipped, failed, deleted, plan };
  }

  /**
   * After a move, optionally remove a stray `.torrent` left in a source folder
   * and prune the folder if it's now empty. Deliberately conservative: every dir
   * is re-validated against the allowed roots, and a root or a library folder
   * itself is never removed (only strictly-nested, empty folders are pruned).
   */
  private async postMoveCleanup(dirs: string[], rules: CleanupRules, roots: string[]): Promise<void> {
    const libraries = await this.prisma.mediaLibrary.findMany({ select: { path: true } });
    const protectedPaths = new Set(
      [...roots, ...libraries.map((l) => l.path)].map((p) => path.resolve(p)),
    );
    for (const dir of dirs) {
      let abs: string;
      try {
        abs = this.assertWithin(dir, roots, 'cleanup dir');
      } catch {
        continue; // outside the allowed roots — never touch
      }
      if (protectedPaths.has(path.resolve(abs))) continue; // never a root/library

      if (rules.removeLeftoverTorrent) {
        try {
          for (const e of await readdir(abs)) {
            if (e.toLowerCase().endsWith('.torrent')) {
              await unlink(path.join(abs, e)).catch(() => undefined);
            }
          }
        } catch {
          /* unreadable dir — skip */
        }
      }

      if (rules.pruneEmptyDirs) {
        try {
          const remaining = await readdir(abs);
          if (remaining.length === 0) await rmdir(abs).catch(() => undefined);
        } catch {
          /* unreadable dir — skip */
        }
      }
    }
  }

  /**
   * If `dest` targets a `Season NN` subfolder and the show folder already holds
   * a folder for the same season number under a different name (e.g. `Season 8`
   * vs the template's `Season 08`), redirect `dest` into that existing folder so
   * an in-place rename doesn't create a duplicate season directory. No-op for
   * movie/Specials destinations or when no sibling matches.
   */
  private async reuseExistingSeasonDir(dest: string): Promise<string> {
    const seasonDir = path.dirname(dest);
    const seasonName = path.basename(seasonDir);
    const want = seasonName.match(/^season\s*0*(\d+)$/i);
    if (!want) return dest;
    const showRoot = path.dirname(seasonDir);
    try {
      for (const e of await readdir(showRoot, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === seasonName) continue;
        const m = e.name.match(/^season\s*0*(\d+)$/i);
        if (m && Number(m[1]) === Number(want[1])) {
          return path.join(showRoot, e.name, path.basename(dest));
        }
      }
    } catch {
      // Show root not readable yet — fall back to the templated season folder.
    }
    return dest;
  }

  private async execute(action: string, src: string, dest: string): Promise<void> {
    switch (action) {
      case 'rename':
      case 'move':
        await rename(src, dest);
        break;
      case 'copy':
        await copyFile(src, dest);
        break;
      case 'hardlink':
        await link(src, dest).catch(async (e) => {
          // Cross-device hardlink fails (EXDEV) — fall back to copy.
          if ((e as NodeJS.ErrnoException).code === 'EXDEV') await copyFile(src, dest);
          else throw e;
        });
        break;
      case 'symlink':
        await symlink(src, dest);
        break;
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  }

  private async log(
    item: { source: string; destination: string | null; action: string; kind: string },
    mode: string,
    status: string,
    torrentHash: string | undefined,
    message: string | null,
  ): Promise<void> {
    await this.prisma.mediaRenameOperation
      .create({
        data: {
          source: item.source,
          destination: item.destination,
          action: item.action,
          kind: item.kind,
          mode,
          status,
          message,
          torrentHash,
        },
      })
      .catch(() => undefined);
  }
}

/**
 * Short, human-readable `{ from, to }` for the activity feed. Prefers the
 * filenames (a rename usually changes the basename); when only the folder moved
 * and the basenames match, it qualifies each with its parent folder so the pair
 * still reads as a change rather than "X → X".
 */
function renameFromTo(source: string, destination: string): { from: string; to: string } {
  const from = path.basename(source);
  const to = path.basename(destination);
  if (from !== to) return { from, to };
  return {
    from: path.join(path.basename(path.dirname(source)), from),
    to: path.join(path.basename(path.dirname(destination)), to),
  };
}
