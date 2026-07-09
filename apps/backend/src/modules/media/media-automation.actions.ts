import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as path from 'node:path';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MediaScannerService } from './media-scanner.service';
import { MediaIdentificationService } from './media-identification.service';
import { MediaMetadataService, type AuditContext } from './media-metadata.service';
import { MediaArtworkService } from './media-artwork.service';
import { MediaNfoService } from './media-nfo.service';
import { MediaServerIntegrationService } from './media-server-integration.service';
import { MediaService } from './media.service';
import { MediaProcessingQueueService } from './media-processing-queue.service';
import { isSeasonContainer, type Preset, type RenameMode } from './media-renamer';

/**
 * Executes the Media Manager automation actions dispatched by the AutomationEngine.
 * Each action delegates to the corresponding Media Manager service — filesystem
 * work stays constrained by FilePathService and audited by those services — and
 * long-running operations are tracked as MediaProcessingJob rows with WS progress
 * via {@link MediaProcessingQueueService}.
 *
 * Kept free of any AutomationEngine dependency so the engine can inject it without
 * a circular reference (the engine depends on this; this depends on media only).
 */
@Injectable()
export class MediaAutomationActions {
  private readonly logger = new Logger(MediaAutomationActions.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scanner: MediaScannerService,
    private readonly identification: MediaIdentificationService,
    private readonly metadata: MediaMetadataService,
    private readonly artwork: MediaArtworkService,
    private readonly nfo: MediaNfoService,
    private readonly integrations: MediaServerIntegrationService,
    private readonly media: MediaService,
    private readonly queue: MediaProcessingQueueService,
  ) {}

  /** Dispatch a `media_*` automation action by type. */
  async execute(
    type: string,
    params: Record<string, unknown> = {},
    ctx: AuditContext = {},
  ): Promise<unknown> {
    const libraryId = params.libraryId ? String(params.libraryId) : undefined;
    const itemId = params.itemId ? String(params.itemId) : undefined;

    switch (type) {
      case 'media_scan_library': {
        if (!libraryId) throw new BadRequestException('libraryId is required');
        return this.queue.run('library_scan', { libraryId }, () =>
          this.scanner.scanLibrary(libraryId),
        );
      }
      case 'media_match': {
        if (!itemId) throw new BadRequestException('itemId is required');
        return this.queue.run('media_identification', { itemId }, () =>
          this.identification.identify(itemId),
        );
      }
      case 'media_fetch_metadata': {
        if (!itemId) throw new BadRequestException('itemId is required');
        return this.queue.run('metadata_fetch', { itemId }, () =>
          this.metadata.fetchMetadata(itemId, ctx),
        );
      }
      case 'media_fetch_artwork': {
        if (!itemId) throw new BadRequestException('itemId is required');
        // Fetch poster/fanart from the configured provider (TMDB). When no key
        // or external id is present, importFromProvider reports the gap instead
        // so a downstream rule / operator can act (upload / select).
        return this.queue.run('artwork_fetch', { itemId }, () =>
          this.artwork.importFromProvider(itemId, ctx),
        );
      }
      case 'media_generate_nfo': {
        if (!itemId && !libraryId) {
          throw new BadRequestException('itemId or libraryId is required');
        }
        return this.queue.run(
          'nfo_generate',
          { itemId, libraryId },
          () => this.nfo.generate({ itemId, libraryId }, ctx),
        );
      }
      case 'media_rename': {
        return this.renameOrMove({ itemId, libraryId }, undefined, ctx);
      }
      case 'media_move': {
        // Force a move into the library structure regardless of the library's
        // default (preview/hardlink/etc.) mode.
        return this.renameOrMove({ itemId, libraryId }, 'rename_move', ctx);
      }
      case 'media_server_refresh': {
        const integrationId = params.integrationId
          ? String(params.integrationId)
          : undefined;
        if (!integrationId) {
          throw new BadRequestException('integrationId is required');
        }
        return this.queue.run(
          'media_server_refresh',
          { payload: { integrationId } },
          () => this.integrations.refresh(integrationId, ctx),
        );
      }
      default:
        throw new BadRequestException(`Unknown media action: ${type}`);
    }
  }

  /**
   * Rename/move an item — or every item in a library — into the library
   * structure using the core renamer (root-guarded + audited by MediaService).
   */
  private async renameOrMove(
    target: { itemId?: string; libraryId?: string },
    modeOverride: RenameMode | undefined,
    ctx: AuditContext,
  ): Promise<unknown> {
    if (target.itemId) {
      return this.queue.run(
        'rename_execute',
        { itemId: target.itemId },
        () => this.renameItem(target.itemId!, modeOverride, ctx),
      );
    }
    if (target.libraryId) {
      return this.queue.run(
        'rename_execute',
        { libraryId: target.libraryId },
        async (report) => {
          const items = await this.prisma.mediaItem.findMany({
            where: { libraryId: target.libraryId },
            select: { id: true },
          });
          let applied = 0;
          let failed = 0;
          for (let i = 0; i < items.length; i++) {
            try {
              await this.renameItem(items[i].id, modeOverride, ctx);
              applied++;
            } catch (err) {
              failed++;
              this.logger.warn(
                `Rename failed for item ${items[i].id}: ${(err as Error).message}`,
              );
            }
            if (items.length) await report(((i + 1) / items.length) * 100);
          }
          return { items: items.length, applied, failed };
        },
      );
    }
    throw new BadRequestException('itemId or libraryId is required');
  }

  /** Build a RenameRequest for one item from its library config and apply it. */
  async renameItem(
    itemId: string,
    modeOverride: RenameMode | undefined,
    ctx: AuditContext = {},
    dryRun = false,
  ) {
    const item = await this.prisma.mediaItem.findUnique({
      where: { id: itemId },
      include: { library: true, files: true },
    });
    if (!item) throw new BadRequestException('Item not found');
    if (!item.library) throw new BadRequestException('Item has no library');

    const src = item.files[0]?.path ?? item.path;
    return this.media.apply({
      path: src,
      preset: (item.library.preset ?? 'plex') as Preset,
      mode: (modeOverride ?? item.library.mode ?? 'hardlink') as RenameMode,
      dryRun,
      libraryPath: item.library.path,
      template: item.library.template ?? undefined,
      // Feed the already-identified title into the parse so a bare filename
      // (e.g. `S01E01.mkv`) still resolves its series title + episode metadata.
      // Prepending the title mirrors the folder-climb the identifier does; the
      // basename keeps the SxxEyy / resolution / group tokens intact.
      sourceName: this.identitySourceName(item),
      // Feeds the dashboard activity row: "Renamed media for {title (year)}".
      label: this.mediaLabel(item),
    });
  }

  /** `"{title} ({year})"` (year omitted for TV) for activity/audit display. */
  private mediaLabel(item: { title: string | null; year: number | null }): string | undefined {
    const title = item.title?.trim();
    if (!title) return undefined;
    return item.year ? `${title} (${item.year})` : title;
  }

  /**
   * Build the identity name a rename should parse from the item's persisted
   * (folder-recovered) title and the file's basename. Returns undefined when
   * there is no resolved title to prepend, leaving the basename as-is.
   */
  private identitySourceName(item: {
    title: string | null;
    year: number | null;
    path: string;
    files: { path: string }[];
  }): string | undefined {
    const base = path.basename(item.files[0]?.path ?? item.path);
    const title = item.title?.trim();
    if (!title) return undefined;
    // Append the identified year (movies) so `{Movie Title} ({year})` and the
    // TMDB query resolve even when the filename omits it; TV items carry a null
    // year, so the episode's SxxEyy in the basename still drives the parse.
    const year = item.year ? ` (${item.year})` : '';
    return `${title}${year} ${base}`;
  }

  /** Library modes that mean "organize my files into the Show/Season layout". */
  private static readonly ORGANIZE_MODES = ['rename_in_place', 'rename_move'];

  /**
   * Organize a whole library: move every not-yet-placed file into the library's
   * `Show/Season NN/` structure and apply junk cleanup (delete-globs, samples,
   * leftover .torrent, empty dirs — via the renamer's cleanup rules). Only
   * `rename_in_place`/`rename_move` libraries are eligible; link/copy/preview
   * libraries are left untouched. Files already correctly placed are skipped, so
   * a re-run is a near no-op. `dryRun` previews the moves + deletes WITHOUT
   * touching disk (each item is planned in `preview` mode).
   *
   * SAFETY GUARD: a move is only applied when it stays **within the file's own
   * show folder** (relocating into a `Season NN/` subdir). A plan that would
   * move the file to a *different* show folder — because the renamer re-derived
   * a different title/year from the release name (e.g. `Tracker (2024)` →
   * `Tracker 2024 (2024)`, or a wrong-year match) — is NOT applied; it's
   * reported under `needsReview` so a genuine mis-identification is never
   * silently turned into a duplicate/wrong folder.
   */
  async organizeLibrary(
    libraryId: string,
    opts: { dryRun?: boolean } = {},
    ctx: AuditContext = {},
    report?: (pct: number, msg?: string) => void | Promise<void>,
  ): Promise<{
    libraryId: string;
    mode: string;
    eligible: boolean;
    dryRun: boolean;
    moves: { itemId: string; from: string; to: string }[];
    deletes: { itemId: string; path: string }[];
    needsReview: { itemId: string; from: string; to: string }[];
    applied: number;
    deleted: number;
    skipped: number;
    failed: number;
  }> {
    const library = await this.prisma.mediaLibrary.findUnique({ where: { id: libraryId } });
    if (!library) throw new BadRequestException('Library not found');
    const dryRun = !!opts.dryRun;
    const eligible = MediaAutomationActions.ORGANIZE_MODES.includes(library.mode);
    const moves: { itemId: string; from: string; to: string }[] = [];
    const deletes: { itemId: string; path: string }[] = [];
    const needsReview: { itemId: string; from: string; to: string }[] = [];
    let applied = 0;
    let deleted = 0;
    let skipped = 0;
    let failed = 0;
    if (!eligible) {
      return { libraryId, mode: library.mode, eligible: false, dryRun, moves, deletes, needsReview, applied, deleted, skipped, failed };
    }

    // Only items that actually need organizing: an episodic file whose parent
    // dir is NOT already a `Season NN`/`Specials` container (i.e. it's loose in
    // the show root or a library root). Correctly-placed episodes — the vast
    // majority — are filtered out here, BEFORE the expensive per-item plan build
    // (which does a metadata provider lookup), so a scan of an organized library
    // is near-instant instead of re-planning thousands of files.
    const all = await this.prisma.mediaItem.findMany({
      where: { libraryId },
      select: { id: true, season: true, episode: true, path: true, files: { select: { path: true }, take: 1 } },
    });
    const items = all.filter((it) => {
      if (it.season == null && it.episode == null) return false; // not an episode
      const filePath = it.files[0]?.path ?? it.path;
      return !isSeasonContainer(path.basename(path.dirname(filePath)));
    });
    // The file's SHOW folder: the first path segment under the library root.
    // Null when the file sits directly at the library root (no show folder of
    // its own — organizing it would *create* one, which we treat as needsReview
    // rather than guess). Used by the guard below to keep a file in its folder.
    const libRoot = library.path.replace(/[/\\]+$/, '');
    const showDir = (p: string): string | null => {
      const norm = p.replace(/[/\\]+$/, '');
      if (!norm.startsWith(`${libRoot}/`)) return null;
      const rel = norm.slice(libRoot.length + 1);
      return rel.includes('/') ? rel.split('/')[0] : null;
    };

    type PlanResult = {
      applied: number; skipped: number; failed: number; deleted: number;
      plan: { items: { source: string; destination: string | null; action: string; skipped: boolean }[] };
    };
    for (let i = 0; i < items.length; i++) {
      const itemId = items[i].id;
      try {
        // Plan under the library's REAL mode (dryRun = no disk writes) to inspect
        // the destination the execute would actually produce. Using mode
        // 'preview' here would mis-resolve an in-place move (re-rooting it under
        // the library instead of reusing the file's own show folder), tripping
        // the guard below for every show whose release name embeds a bare year
        // (e.g. "Hijack.2023.S02E03"). Provider lookups are cached, so the later
        // execute re-plan is a cache hit.
        const preview = (await this.renameItem(itemId, undefined, ctx, true)) as PlanResult;
        const move = preview.plan.items.find(
          (p) => p.action !== 'delete' && !p.skipped && p.destination && p.destination !== p.source,
        );
        // GUARD: only relocate WITHIN the file's own show folder. A move to a
        // different (re-derived) show folder — or one that would create a show
        // folder for a file loose at the library root — is held for review.
        if (move) {
          const fromShow = showDir(move.source);
          if (fromShow === null || fromShow !== showDir(move.destination!)) {
            needsReview.push({ itemId, from: move.source, to: move.destination! });
            continue;
          }
        }
        if (move) moves.push({ itemId, from: move.source, to: move.destination! });
        for (const p of preview.plan.items) {
          if (p.action === 'delete') deletes.push({ itemId, path: p.source });
        }
        if (!dryRun && (move || preview.plan.items.some((p) => p.action === 'delete'))) {
          const res = (await this.renameItem(itemId, undefined, ctx)) as PlanResult;
          applied += res.applied;
          deleted += res.deleted;
          skipped += res.skipped;
          failed += res.failed;
        }
      } catch (err) {
        failed++;
        this.logger.warn(`organize item ${itemId} failed: ${(err as Error).message}`);
      }
      if (report && items.length) await report(((i + 1) / items.length) * 100);
    }
    return { libraryId, mode: library.mode, eligible: true, dryRun, moves, deletes, needsReview, applied, deleted, skipped, failed };
  }
}
