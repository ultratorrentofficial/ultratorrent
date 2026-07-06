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

    const { sourceName, files } = req.hash
      ? await this.gatherTorrentFiles(req.hash, req.engineId)
      : req.path
        ? await this.gatherPathFiles(req.path)
        : (() => {
            throw new BadRequestException('Provide a torrent hash or a path');
          })();

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
    });
  }

  // --- execution ---------------------------------------------------------
  async apply(req: RenameRequest): Promise<{
    applied: number;
    skipped: number;
    failed: number;
    plan: RenamePlan;
  }> {
    const plan = await this.buildPlan(req);
    let applied = 0;
    let skipped = 0;
    let failed = 0;

    if (plan.mode === 'preview') {
      return { applied: 0, skipped: plan.items.length, failed: 0, plan };
    }

    const roots = await this.allowedRoots();
    // The chosen library must itself live under an allowed root.
    this.assertWithin(plan.libraryPath, roots, 'libraryPath');

    for (const item of plan.items) {
      if (item.skipped || !item.destination) {
        skipped++;
        continue;
      }
      try {
        const src = this.assertWithin(item.source, roots, 'source');
        // Reject symlink escapes from the real source location.
        const realSrc = await realpath(src).catch(() => src);
        this.assertWithin(realSrc, roots, 'source');
        const dest = this.assertWithin(item.destination, roots, 'destination');

        await mkdir(path.dirname(dest), { recursive: true });
        await this.execute(item.action, realSrc, dest);
        applied++;
        await this.log(item, plan.mode, 'success', req.hash, null);
      } catch (err) {
        failed++;
        await this.log(item, plan.mode, 'failed', req.hash, (err as Error).message);
        this.logger.warn(`rename failed: ${(err as Error).message}`);
      }
    }

    await this.audit.record({
      action: 'media.rename',
      result: failed > 0 ? 'failure' : 'success',
      objectType: 'torrent',
      objectId: req.hash,
      metadata: { applied, skipped, failed, mode: plan.mode, libraryPath: plan.libraryPath },
    });

    return { applied, skipped, failed, plan };
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
