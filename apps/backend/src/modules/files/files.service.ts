import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import * as path from 'node:path';
import type { Response } from 'express';
import {
  WS_EVENTS,
  filePreviewKind,
  filePreviewMime,
  isStreamableKind,
  type BrowseResponse,
  type FileNode,
  type FileOperationEventPayload,
  type FileOperationResult,
  type FileOperationType,
  type FilePreviewResponse,
  type FilePropertiesResponse,
  type PreviewTextEncoding,
} from '@ultratorrent/shared';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { FilePathService, type FileOpContext } from './file-path.service';
import { TRASH_DIR_NAME, assertSafeName } from './path-safety';
import { parseByteRange } from './byte-range';
import { decodeText, looksBinary } from './preview-text';
import {
  computeSize,
  copyRecursive,
  countItems,
  moveRecursive,
  pathExists,
  statSafe,
} from './file-fs.util';
import { DOMAIN_EVENTS } from '@ultratorrent/shared';
import { DomainEventBus } from '../domain-events/domain-event-bus.service';
import { ModuleRef } from '@nestjs/core';
import { TrashService } from './trash.service';
import type {
  BulkOperationDto,
  CopyFileDto,
  CreateFolderDto,
  DeleteFileDto,
  MoveFileDto,
  RenameFileDto,
  ResolveConflictsDto,
} from './dto/file.dto';

/** Largest file we will hash for the Properties dialog (64 MiB). */
const HASH_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * How much of a text file the preview reads (1 MiB).
 *
 * Not a refusal threshold — a longer file is read up to here and reported as
 * truncated. Sized to hold any subtitle or NFO whole, and a useful head of a log.
 */
const TEXT_PREVIEW_LIMIT_BYTES = 1024 * 1024;

/**
 * Which path boundary an operation resolves against — the operator's narrowed
 * browse root, or the ops hard roots for system-initiated storage maintenance.
 */
export type PathScope = 'browse' | 'storage';

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly paths: FilePathService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    private readonly trash: TrashService,
    private readonly bus: DomainEventBus,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Publish a file-level fact.
   *
   * Best-effort by construction: `publish()` never throws, and a bookkeeping
   * subscriber must not be able to fail an operation that already touched disk.
   */
  private announceMove(from: string, to: string): void {
    if (from === to) return;
    this.bus.publish({
      eventKey: DOMAIN_EVENTS.FILE_MOVED,
      resourceType: 'file',
      resourceId: to,
      payload: { from, to },
    });
  }

  private announceDelete(path: string): void {
    this.bus.publish({
      eventKey: DOMAIN_EVENTS.FILE_DELETED,
      resourceType: 'file',
      resourceId: path,
      payload: { path },
    });
  }

  private get safety() {
    return this.paths.safety;
  }

  private get storageSafety() {
    return this.paths.storageSafety;
  }

  // --- read ----------------------------------------------------------------

  /**
   * List a directory.
   *
   * With several roots, `/` is a VIRTUAL level that lists the roots themselves.
   * There is no real directory above them — their common ancestor would be a
   * system directory outside the boundary — so without it the browser opens on
   * whichever root happens to be first and has no way to reach the others.
   * It is answered before `resolveExisting`, which refuses `/` correctly.
   */
  async browse(requested: string): Promise<BrowseResponse> {
    if (this.safety.usesAbsolutePaths && (!requested || requested === '/')) {
      return this.browseRoots();
    }
    const dir = await this.safety.resolveExisting(requested || '/');
    const info = await statSafe(dir);
    if (info && !info.isDirectory()) {
      throw new BadRequestException('Not a directory');
    }
    const entries = await readdir(dir, { withFileTypes: true });
    const items: FileNode[] = await Promise.all(
      entries
        // Hide the trash directory from normal browsing.
        .filter((e) => e.name !== TRASH_DIR_NAME)
        .map(async (e) => {
          const full = path.join(dir, e.name);
          const s = await statSafe(full);
          return {
            name: e.name,
            path: this.safety.toRelative(full),
            isDirectory: e.isDirectory(),
            size: s?.size ?? 0,
            modifiedAt: s?.mtime.toISOString() ?? null,
          };
        }),
    );
    items.sort((a, b) =>
      a.isDirectory === b.isDirectory
        ? a.name.localeCompare(b.name)
        : a.isDirectory
          ? -1
          : 1,
    );
    return { path: this.safety.toRelative(dir), roots: this.safety.listRoots(), items };
  }

  /**
   * The virtual top level of a multi-root deployment: one entry per root.
   *
   * Labelled by basename, which is short and reads naturally
   * (`downloads`, `orico`) — but basenames can collide across roots, so a
   * repeated one falls back to the full path rather than showing the operator
   * two identical folders. `path` is the absolute root either way, which is
   * what a multi-root client addresses files by.
   */
  private async browseRoots(): Promise<BrowseResponse> {
    const roots = this.safety.listRoots();
    const seen = new Map<string, number>();
    for (const root of roots) {
      const base = path.basename(root) || root;
      seen.set(base, (seen.get(base) ?? 0) + 1);
    }
    const items: FileNode[] = await Promise.all(
      roots.map(async (root) => {
        const base = path.basename(root) || root;
        const s = await statSafe(root);
        return {
          name: (seen.get(base) ?? 0) > 1 ? root : base,
          path: root,
          isDirectory: true,
          size: 0,
          modifiedAt: s?.mtime.toISOString() ?? null,
        };
      }),
    );
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { path: '/', roots, items };
  }

  async properties(requested: string): Promise<FilePropertiesResponse> {
    const target = await this.safety.resolveExisting(requested);
    const info = await stat(target);
    const isDir = info.isDirectory();
    return {
      name: path.basename(target),
      path: this.safety.toRelative(target),
      absolutePath: target,
      isDirectory: isDir,
      size: isDir ? await computeSize(target) : info.size,
      itemCount: isDir ? await countItems(target) : undefined,
      extension: isDir ? null : path.extname(target).replace(/^\./, '') || null,
      createdAt: info.birthtime ? info.birthtime.toISOString() : null,
      modifiedAt: info.mtime.toISOString(),
      hash: isDir ? null : await this.hashFile(target, info.size),
      media: null,
    };
  }

  /**
   * What to show for one file, and — for anything text-shaped — its text.
   *
   * This used to be `readFile(path, 'utf8')` with a hard 256 KB ceiling, which
   * answered "cannot preview" for every image, every video, and every NFO long
   * enough to matter. The kind now decides the answer: streamable media reports
   * where its bytes live and returns none of them, text is decoded through the
   * detector (CP437 NFOs included), and a format with nothing to show says so
   * instead of failing.
   *
   * Never throws for an unpreviewable file — `reason` carries that, so the
   * dialog can still offer Download rather than showing an error.
   */
  async preview(
    requested: string,
    opts: { encoding?: PreviewTextEncoding | null; maxBytes?: number } = {},
  ): Promise<FilePreviewResponse> {
    const maxBytes = opts.maxBytes ?? TEXT_PREVIEW_LIMIT_BYTES;
    const target = await this.safety.resolveExisting(requested);
    const info = await stat(target);
    if (info.isDirectory()) throw new BadRequestException('Cannot preview a directory');

    const name = path.basename(target);
    const kind = filePreviewKind(name);
    const base = {
      path: this.safety.toRelative(target),
      name,
      size: info.size,
      kind,
      mime: filePreviewMime(name),
      streamable: isStreamableKind(kind),
      content: null,
      encoding: null,
      detectedEncoding: null,
      truncated: false,
      reason: null,
    } satisfies FilePreviewResponse;

    // Media and PDFs are bytes, not text: the client fetches them from the
    // stream route with a ticket, so reading them here would be pure waste.
    if (base.streamable) return base;
    if (kind === 'archive') return { ...base, reason: 'Archives cannot be previewed' };
    if (info.size === 0) return { ...base, content: '', encoding: 'utf-8', detectedEncoding: 'utf-8' };

    /*
     * Read only the window we will show. A 2 GB log is a legitimate thing to
     * find in a download directory, and the old ceiling refused it outright;
     * reading its head and saying so is strictly more useful. One extra byte
     * distinguishes "exactly at the limit" from "there is more".
     */
    const handle = await open(target, 'r');
    let buf: Buffer;
    try {
      const chunk = Buffer.alloc(Math.min(info.size, maxBytes + 1));
      // Read until the window is full or the file ends: a single `read()` is
      // allowed to come back short, and trusting it would silently truncate the
      // preview at whatever boundary the filesystem chose.
      let filled = 0;
      while (filled < chunk.length) {
        const { bytesRead } = await handle.read(chunk, filled, chunk.length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      buf = chunk.subarray(0, filled);
    } finally {
      await handle.close();
    }

    const truncated = buf.length > maxBytes;
    if (truncated) buf = buf.subarray(0, maxBytes);

    /*
     * An unrecognised extension is not a promise of binary. `.txt`-in-all-but-name
     * files are everywhere (READMEs without a suffix, `.sfv`-alikes), so the bytes
     * get the deciding vote — but a file that really is binary must not be dumped
     * into a `<pre>` as garbage.
     */
    if (looksBinary(buf)) {
      return { ...base, reason: 'This file is binary and has no text preview' };
    }

    const ext = path.extname(target).replace(/^\./, '').toLowerCase();
    const { content, encoding, detected } = decodeText(buf, ext, opts.encoding ?? null);
    return { ...base, content, encoding, detectedEncoding: detected, truncated };
  }

  /**
   * Stream a file's bytes with Range support, for an `<img>`/`<video>`/`<audio>`
   * element or an inline PDF.
   *
   * Separate from `download` on two counts: it honours Range (so a player can
   * seek instead of buffering a whole remux), and it serves `inline` with the
   * file's real MIME so the browser renders rather than saves it. Everything the
   * MIME map does not vouch for goes out as `application/octet-stream` with
   * `nosniff`, so an unrecognised file can never be talked into executing as
   * something else on the API's origin.
   */
  async streamMedia(
    requested: string,
    rangeHeader: string | undefined,
    res: Response,
    opts: { headOnly?: boolean } = {},
  ): Promise<StreamableFile> {
    const target = await this.safety.resolveExisting(requested);
    const info = await stat(target);
    if (info.isDirectory()) throw new BadRequestException('Cannot stream a directory');

    const name = path.basename(target);
    const mime = filePreviewMime(name);
    res.set({
      'Content-Type': mime,
      'Content-Disposition': `inline; filename="${encodeURIComponent(name)}"`,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      // A ticketed URL is a capability; a shared cache must not keep the bytes.
      'Cache-Control': 'private, max-age=0, no-store',
    });
    // SVG is the one image type that is also a document. Inside `<img>` its
    // scripts are already inert; this covers a direct navigation to the URL.
    // Appended to whatever policy the caller already set (the controller scopes
    // `frame-ancestors` there) rather than replacing it — `res.set` overwrites,
    // and dropping that directive would leave the resource framable by anyone.
    if (mime === 'image/svg+xml') {
      const existing = res.getHeader('Content-Security-Policy');
      const directives = ["default-src 'none'", "style-src 'unsafe-inline'", 'sandbox'];
      if (typeof existing === 'string' && existing) directives.push(existing);
      res.set({ 'Content-Security-Policy': directives.join('; ') });
    }

    const range = parseByteRange(rangeHeader, info.size);
    if (range === 'unsatisfiable') {
      res.status(416);
      res.set({ 'Content-Range': `bytes */${info.size}` });
      return new StreamableFile(Readable.from([]));
    }
    if (!range) {
      res.set({ 'Content-Length': String(info.size) });
      return opts.headOnly
        ? new StreamableFile(Readable.from([]))
        : new StreamableFile(createReadStream(target));
    }
    res.status(206);
    res.set({
      'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
      'Content-Length': String(range.end - range.start + 1),
    });
    return opts.headOnly
      ? new StreamableFile(Readable.from([]))
      : new StreamableFile(createReadStream(target, { start: range.start, end: range.end }));
  }

  async download(requested: string, res: Response): Promise<StreamableFile> {
    const target = await this.safety.resolveExisting(requested);
    const info = await stat(target);
    if (info.isDirectory()) throw new BadRequestException('Cannot download a directory');
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(target))}"`,
      'Content-Length': String(info.size),
    });
    return new StreamableFile(createReadStream(target));
  }

  // --- mutate --------------------------------------------------------------

  async createFolder(dto: CreateFolderDto, ctx: FileOpContext = {}): Promise<FileOperationResult> {
    assertSafeName(dto.name, 'folder name');
    const target = this.safety.resolveLogical(path.join(dto.path, dto.name));
    return this.perform({
      operation: 'create_folder',
      action: 'file.created_folder',
      ctx,
      destination: this.safety.toRelative(target),
      run: async () => {
        if (await pathExists(target)) throw new ConflictException('A file or folder with that name already exists');
        await mkdir(target, { recursive: false });
        return { path: this.safety.toRelative(target) };
      },
    });
  }

  async rename(dto: RenameFileDto, ctx: FileOpContext = {}): Promise<FileOperationResult> {
    assertSafeName(dto.newName, 'file name');
    const src = await this.safety.resolveExisting(dto.path);
    this.safety.assertDeletable(src); // renaming a root is forbidden
    // Sibling in the same directory; src is already absolute+validated, so use
    // the containment check (resolveLogical would re-base the absolute path).
    const dest = this.safety.ensureContained(path.join(path.dirname(src), dto.newName));
    return this.perform({
      operation: 'rename',
      action: 'file.renamed',
      ctx,
      source: this.safety.toRelative(src),
      destination: this.safety.toRelative(dest),
      run: async () => {
        if (dest !== src && (await pathExists(dest)) && !dto.overwrite) {
          throw new ConflictException('A file or folder with that name already exists');
        }
        await rename(src, dest);
        // Say what happened. Media follows the file through the bus rather than
        // this module reaching into it — media already depends on files, so a
        // direct call would close a cycle.
        this.announceMove(src, dest);
        return { path: this.safety.toRelative(dest) };
      },
    });
  }

  async move(dto: MoveFileDto, ctx: FileOpContext = {}): Promise<FileOperationResult> {
    const src = await this.safety.resolveExisting(dto.source);
    this.safety.assertDeletable(src);
    const dest = this.resolveInto(dto.destination, path.basename(src));
    this.assertNotIntoSelf(src, dest);
    return this.perform({
      operation: 'move',
      action: 'file.moved',
      ctx,
      source: this.safety.toRelative(src),
      destination: this.safety.toRelative(dest),
      run: async () => {
        if (await pathExists(dest)) {
          if (!dto.overwrite) throw new ConflictException('Destination already exists');
          await rm(dest, { recursive: true, force: true });
        }
        const bytes = await computeSize(src);
        await moveRecursive(src, dest, !!dto.overwrite);
        this.announceMove(src, dest);
        return { path: this.safety.toRelative(dest), bytes };
      },
    });
  }

  async copy(dto: CopyFileDto, ctx: FileOpContext = {}): Promise<FileOperationResult> {
    const src = await this.safety.resolveExisting(dto.source);
    const dest = this.resolveInto(dto.destination, path.basename(src));
    this.assertNotIntoSelf(src, dest);
    return this.perform({
      operation: 'copy',
      action: 'file.copied',
      ctx,
      source: this.safety.toRelative(src),
      destination: this.safety.toRelative(dest),
      run: async () => {
        if ((await pathExists(dest)) && !dto.overwrite) {
          throw new ConflictException('Destination already exists');
        }
        const bytes = await computeSize(src);
        await copyRecursive(src, dest, !!dto.overwrite);
        return { path: this.safety.toRelative(dest), bytes, itemCount: 1 };
      },
    });
  }

  /**
   * Delete a path, to Trash unless `permanent`.
   *
   * `scope` selects the boundary the path is resolved against. `browse` (the
   * default) honours the admin's narrowed Default Root Path, because the caller
   * is the file manager and the operator is acting inside what they can see.
   * `storage` pins to the ops hard roots and is for system-initiated maintenance
   * on configured storage — see {@link FilePathService.storageSafety}.
   */
  /**
   * What else holds the bytes under a path — torrents, and how much a delete
   * would really free. Read-only; the dialog calls it before asking.
   *
   * Resolved lazily because `MediaModule` imports `FilesModule`, so importing it
   * back would close a cycle that only fails at bootstrap.
   */
  async deletionPreview(path: string, scope: PathScope = 'browse') {
    const safety = scope === 'storage' ? this.storageSafety : this.safety;
    const target = await safety.resolveExisting(path);
    try {
      const { MediaLinkageService } = await import('../media/media-linkage.service');
      const linkage = this.moduleRef.get(MediaLinkageService, { strict: false });
      const [described, torrents, live] = await Promise.all([
        linkage.describePaths([target]),
        linkage.torrentsForPaths([target]),
        linkage.liveHashes(),
      ]);
      return {
        ...described[0],
        path: target,
        torrents: torrents.map((t) => ({ ...t, live: live.has(t.torrentHash.toLowerCase()) })),
      };
    } catch (err) {
      // A preflight must never be the reason a delete cannot happen. It reports
      // nothing rather than failing the operation.
      this.logger.warn(`Deletion preview failed for ${target}: ${(err as Error).message}`);
      return { path: target, exists: true, links: 1, sizeBytes: 0, freesBytes: 0, torrent: null, torrents: [] };
    }
  }


  /**
   * Stop, or stop and erase, the torrents whose payload this path belonged to.
   *
   * Runs AFTER the delete: the operator asked for the file to go, and a torrent
   * step that failed must not leave the file standing while reporting failure.
   * `keep` (the default, and the historical behaviour) does nothing at all.
   */
  private async applyTorrentAction(
    target: string,
    action: 'keep' | 'stop' | 'stop_and_delete' | undefined,
    ctx: FileOpContext,
  ): Promise<void> {
    if (!action || action === 'keep') return;
    try {
      const { MediaLinkageService } = await import('../media/media-linkage.service');
      const { TorrentsService } = await import('../torrents/torrents.service');
      const linkage = this.moduleRef.get(MediaLinkageService, { strict: false });
      const torrents = this.moduleRef.get(TorrentsService, { strict: false });
      const linked = await linkage.torrentsForPaths([target]);
      const user = { id: ctx.userId ?? 'system', username: 'system', roles: [], permissions: [] };
      const auditCtx = { ipAddress: ctx.ipAddress, userAgent: ctx.userAgent };
      for (const t of linked) {
        if (action === 'stop_and_delete') {
          await torrents.removeData(t.torrentHash, t.engineId ?? undefined, user as never, auditCtx, {
            removeLibraryItems: false,
          });
        } else {
          await torrents.remove(t.torrentHash, t.engineId ?? undefined, user as never, auditCtx);
        }
      }
    } catch (err) {
      this.logger.warn(`Torrent ${action} after delete failed: ${(err as Error).message}`);
    }
  }


  /**
   * The same preflight as {@link deletionPreview}, aggregated over a selection.
   *
   * A multi-select cannot ask the per-path question N times — the operator
   * makes ONE decision — so the torrents are de-duplicated (a season pack backs
   * many files) and the reclaimable figure is summed from what each path would
   * genuinely free rather than from file sizes.
   */
  async bulkDeletionPreview(paths: string[], scope: PathScope = 'browse') {
    const safety = scope === 'storage' ? this.storageSafety : this.safety;
    const targets: string[] = [];
    for (const p of paths ?? []) {
      try {
        targets.push(await safety.resolveExisting(p));
      } catch {
        // Unresolvable paths are the bulk operation's problem to report, not
        // the preflight's; they simply contribute nothing here.
      }
    }
    if (!targets.length) return { paths: 0, freesBytes: 0, sizeBytes: 0, torrents: [] };
    try {
      const { MediaLinkageService } = await import('../media/media-linkage.service');
      const linkage = this.moduleRef.get(MediaLinkageService, { strict: false });
      const [described, torrents, live] = await Promise.all([
        linkage.describePaths(targets),
        linkage.torrentsForPaths(targets),
        linkage.liveHashes(),
      ]);
      return {
        paths: targets.length,
        sizeBytes: described.reduce((t, d) => t + d.sizeBytes, 0),
        freesBytes: described.reduce((t, d) => t + d.freesBytes, 0),
        torrents: torrents.map((t) => ({ ...t, live: live.has(t.torrentHash.toLowerCase()) })),
      };
    } catch (err) {
      this.logger.warn(`Bulk deletion preview failed: ${(err as Error).message}`);
      return { paths: targets.length, freesBytes: 0, sizeBytes: 0, torrents: [] };
    }
  }

  async remove(
    dto: DeleteFileDto,
    ctx: FileOpContext = {},
    scope: PathScope = 'browse',
  ): Promise<FileOperationResult> {
    const safety = scope === 'storage' ? this.storageSafety : this.safety;
    let rel = dto.path;
    this.emit('delete', { source: rel, at: new Date().toISOString() }, 'started');
    try {
      const target = await safety.resolveExisting(dto.path);
      safety.assertDeletable(target);
      rel = safety.toRelative(target);
      if (dto.permanent) {
        if (!(await pathExists(target))) throw new NotFoundException('Item not found');
        const bytes = await computeSize(target);
        await rm(target, { recursive: true, force: true });
        // A permanent delete is the same fact as a trash as far as records are
        // concerned: the file is no longer where any of them say it is. Missing
        // this branch would have left the one irreversible path unannounced.
        this.announceDelete(target);
        await this.applyTorrentAction(target, dto.torrentAction, ctx);
        await this.audit.record({
          userId: ctx.userId,
          action: 'file.deleted',
          objectType: 'file',
          objectId: rel,
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          metadata: { mode: 'permanent', bytes },
        });
        this.emit('delete', { source: rel, bytes, result: 'success', at: new Date().toISOString() }, 'completed');
        return { operation: 'delete', ok: true, path: rel, bytes, message: 'permanently deleted' };
      }
      // Trash mode (audits + emits trash.updated inside the trash service). The
      // same safety goes with it so the trash directory is sited in the root that
      // actually contains the file, not the narrowed browse root.
      const item = await this.trash.moveToTrash(target, ctx, safety);
      // Trashing is a removal from the library as far as media records are
      // concerned — the file is no longer where any of them say it is.
      this.announceDelete(target);
      await this.applyTorrentAction(target, dto.torrentAction, ctx);
      this.emit('delete', { source: rel, bytes: item.size, result: 'success', at: new Date().toISOString() }, 'completed');
      return { operation: 'delete', ok: true, path: rel, bytes: item.size, message: 'moved to trash' };
    } catch (err) {
      await this.auditFailure('file.deleted', rel, undefined, ctx, err);
      this.emit('delete', { source: rel, result: 'failure', message: (err as Error).message, at: new Date().toISOString() }, 'failed');
      throw err;
    }
  }

  /**
   * Carry out move/copy decisions the operator made against a conflict report.
   *
   * Returns the same envelope as {@link bulk} — per-item outcomes, never a throw —
   * because the outcomes are genuinely independent: one refused replace must not
   * abandon the other four files. The frontend reads it through `bulk-result`.
   *
   * Destructive steps route through Trash unless `permanent`, so a
   * misjudged replace or delete stays recoverable. `targetPath` is taken from the
   * preflight rather than re-derived, but is re-validated here — it must resolve
   * inside the destination directory, so a stale or forged path cannot make this
   * delete something elsewhere.
   */
  async resolveConflicts(
    dto: ResolveConflictsDto,
    ctx: FileOpContext = {},
  ): Promise<{
    operation: string;
    total: number;
    succeeded: number;
    failed: number;
    results: Array<{ path: string; ok: boolean; message?: string }>;
  }> {
    /*
     * `resolveExisting`, not `resolveLogical`: a destination that EXISTS must be
     * checked against its real path.
     *
     * Reads and deletes were already symlink-safe, but a write destination was
     * only checked logically — so a symlink inside a root pointing outside it
     * passed, and files moved through it landed outside the roots entirely.
     * That is reachable rather than theoretical: torrent payloads are supplied
     * by strangers, can contain symlinks, and land inside these roots by
     * design. `resolveExisting` falls back to the logical path when the
     * destination does not exist yet, which is the create-a-new-folder case.
     */
    const destDir = await this.safety.resolveExisting(dto.destination);
    const results: Array<{ path: string; ok: boolean; message?: string }> = [];

    for (const item of dto.items) {
      try {
        const message = await this.applyResolution(item, destDir, dto, ctx);
        results.push({ path: item.source, ok: true, message });
      } catch (err) {
        results.push({ path: item.source, ok: false, message: (err as Error).message });
      }
    }

    const succeeded = results.filter((r) => r.ok).length;
    await this.audit.record({
      userId: ctx.userId,
      action: `file.resolve.${dto.operation}`,
      result: succeeded === dto.items.length ? 'success' : 'failure',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: {
        total: dto.items.length,
        succeeded,
        failed: dto.items.length - succeeded,
        permanent: !!dto.permanent,
        resolutions: dto.items.map((i) => i.resolution),
      },
    });
    this.realtime.broadcast(WS_EVENTS.FILES_OP_COMPLETED, {
      operation: dto.operation,
      itemCount: dto.items.length,
      result: succeeded === dto.items.length ? 'success' : 'failure',
      at: new Date().toISOString(),
    } satisfies FileOperationEventPayload);

    return {
      operation: dto.operation,
      total: dto.items.length,
      succeeded,
      failed: dto.items.length - succeeded,
      results,
    };
  }

  /** One decision. Returns the message recorded against the item. */
  private async applyResolution(
    item: ResolveConflictsDto['items'][number],
    destDir: string,
    dto: ResolveConflictsDto,
    ctx: FileOpContext,
  ): Promise<string> {
    if (item.resolution === 'skip') return 'skipped';

    const src = await this.safety.resolveExisting(item.source);
    this.safety.assertDeletable(src);

    if (item.resolution === 'delete_source') {
      // The target already holds what we want; the source is what goes.
      await this.dispose(src, !!dto.permanent, ctx);
      return dto.permanent ? 'source deleted' : 'source moved to trash';
    }

    if (item.resolution === 'replace') {
      const target = await this.resolveTargetIn(item.targetPath, destDir);
      await this.dispose(target, !!dto.permanent, ctx);
      // The target is gone, so the destination name is free. `overwrite` stays
      // false: anything still in the way is a surprise, and must surface.
      await this.transfer(dto.operation, item.source, this.safety.toRelative(destDir), ctx);
      return dto.permanent ? 'replaced (target deleted)' : 'replaced (target moved to trash)';
    }

    // keep_both — land alongside the target. Only a name collision needs a new
    // name; a different release name coexists as-is.
    const dest = await this.freeName(destDir, path.basename(src));
    await this.transferTo(dto.operation, src, dest);
    return path.basename(dest) === path.basename(src) ? 'kept both' : `kept both (as ${path.basename(dest)})`;
  }

  /** Trash (recoverable) or hard-delete, per the operator's choice. */
  private async dispose(abs: string, permanent: boolean, ctx: FileOpContext): Promise<void> {
    this.safety.assertDeletable(abs);
    if (permanent) {
      await rm(abs, { recursive: true, force: true });
      await this.audit.record({
        userId: ctx.userId,
        action: 'file.deleted',
        objectType: 'file',
        objectId: this.safety.toRelative(abs),
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        metadata: { mode: 'permanent', reason: 'conflict resolution' },
      });
      return;
    }
    await this.trash.moveToTrash(abs, ctx);
  }

  /**
   * Validate a preflight-supplied target. It must exist and sit directly in the
   * destination directory — never trust the client with a path to delete.
   */
  private async resolveTargetIn(targetPath: string | undefined, destDir: string): Promise<string> {
    if (!targetPath) throw new BadRequestException('targetPath is required to replace');
    const abs = await this.safety.resolveExisting(targetPath);
    if (path.dirname(abs) !== destDir) {
      throw new BadRequestException('Target is not in the destination directory');
    }
    if (!(await pathExists(abs))) throw new NotFoundException('Target no longer exists');
    return abs;
  }

  /** `<name> (2).mkv`, `(3)`… — the first that is free. */
  private async freeName(destDir: string, name: string): Promise<string> {
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    let candidate = path.join(destDir, name);
    for (let n = 2; await pathExists(candidate); n++) {
      candidate = path.join(destDir, `${stem} (${n})${ext}`);
      if (n > 99) throw new ConflictException('Could not find a free name in the destination');
    }
    return this.safety.ensureContained(candidate);
  }

  /** Route through the audited move/copy so the operation logs like any other. */
  private transfer(op: 'move' | 'copy', source: string, destination: string, ctx: FileOpContext) {
    return op === 'move'
      ? this.move({ source, destination }, ctx)
      : this.copy({ source, destination }, ctx);
  }

  /** Transfer to an exact path (keep_both may have renamed it). */
  private async transferTo(op: 'move' | 'copy', src: string, dest: string): Promise<void> {
    if (op === 'move') {
      await moveRecursive(src, dest, false);
      return;
    }
    await copyRecursive(src, dest, false);
  }

  async bulk(dto: BulkOperationDto, ctx: FileOpContext = {}): Promise<{
    operation: string;
    total: number;
    succeeded: number;
    failed: number;
    results: Array<{ path: string; ok: boolean; message?: string }>;
  }> {
    const results: Array<{ path: string; ok: boolean; message?: string }> = [];
    for (const p of dto.paths) {
      try {
        switch (dto.operation) {
          case 'move':
            if (!dto.destination) throw new BadRequestException('destination is required for move');
            await this.move({ source: p, destination: dto.destination, overwrite: dto.overwrite }, ctx);
            break;
          case 'copy':
            if (!dto.destination) throw new BadRequestException('destination is required for copy');
            await this.copy({ source: p, destination: dto.destination, overwrite: dto.overwrite }, ctx);
            break;
          case 'delete':
          case 'cleanup':
            // The torrent decision is made ONCE for the whole selection and
            // applied per path; `remove` no-ops on `keep`, the default.
            await this.remove({ path: p, permanent: dto.permanent, torrentAction: dto.torrentAction }, ctx);
            break;
          default:
            throw new BadRequestException(`Unsupported bulk operation: ${dto.operation}`);
        }
        results.push({ path: p, ok: true });
      } catch (err) {
        results.push({ path: p, ok: false, message: (err as Error).message });
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    await this.audit.record({
      userId: ctx.userId,
      action: `file.bulk.${dto.operation}`,
      result: succeeded === dto.paths.length ? 'success' : 'failure',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { total: dto.paths.length, succeeded, failed: dto.paths.length - succeeded },
    });
    this.realtime.broadcast(WS_EVENTS.FILES_OP_COMPLETED, {
      operation: 'bulk',
      itemCount: dto.paths.length,
      result: succeeded === dto.paths.length ? 'success' : 'failure',
      at: new Date().toISOString(),
    } satisfies FileOperationEventPayload);
    return { operation: dto.operation, total: dto.paths.length, succeeded, failed: dto.paths.length - succeeded, results };
  }

  // --- helpers -------------------------------------------------------------

  /** Resolve `name` inside destination directory `destDir` (root-relative in). */
  private resolveInto(destDir: string, name: string): string {
    return this.safety.resolveLogical(path.join(destDir, name));
  }

  /** Forbid moving/copying a directory into itself or a descendant. */
  private assertNotIntoSelf(src: string, dest: string): void {
    if (dest === src || dest.startsWith(src + path.sep)) {
      throw new BadRequestException('Cannot move or copy an item into itself');
    }
  }

  private async hashFile(abs: string, size: number): Promise<string | null> {
    if (size > HASH_LIMIT_BYTES) return null;
    return new Promise((resolve) => {
      const h = createHash('sha256');
      const s = createReadStream(abs);
      s.on('data', (d) => h.update(d));
      s.on('end', () => resolve(h.digest('hex')));
      s.on('error', () => resolve(null));
    });
  }

  private emit(
    operation: FileOperationType,
    payload: Partial<FileOperationEventPayload>,
    phase: 'started' | 'completed' | 'failed',
  ): void {
    const event =
      phase === 'started'
        ? WS_EVENTS.FILES_OP_STARTED
        : phase === 'completed'
          ? WS_EVENTS.FILES_OP_COMPLETED
          : WS_EVENTS.FILES_OP_FAILED;
    this.realtime.broadcast(event, { operation, at: new Date().toISOString(), ...payload });
  }

  private async auditFailure(
    action: string,
    objectId: string,
    destination: string | undefined,
    ctx: FileOpContext,
    err: unknown,
  ): Promise<void> {
    await this.audit.record({
      userId: ctx.userId,
      action: 'file.operation_failed',
      objectType: 'file',
      objectId,
      result: 'failure',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { intended: action, destination, error: (err as Error).message },
    });
  }

  /** Wrap a mutating op: emit started → run → audit + emit completed/failed. */
  private async perform(opts: {
    operation: FileOperationType;
    action: string;
    ctx: FileOpContext;
    source?: string;
    destination?: string;
    run: () => Promise<{ path?: string; itemCount?: number; bytes?: number }>;
  }): Promise<FileOperationResult> {
    const { operation, action, ctx, source, destination, run } = opts;
    this.emit(operation, { source, destination, at: new Date().toISOString() }, 'started');
    try {
      const out = await run();
      await this.audit.record({
        userId: ctx.userId,
        action,
        objectType: 'file',
        objectId: source ?? destination,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        metadata: { source, destination, bytes: out.bytes, itemCount: out.itemCount },
      });
      this.emit(operation, { source, destination: out.path ?? destination, bytes: out.bytes, itemCount: out.itemCount, result: 'success', at: new Date().toISOString() }, 'completed');
      return { operation, ok: true, path: out.path, itemCount: out.itemCount, bytes: out.bytes };
    } catch (err) {
      await this.auditFailure(action, source ?? destination ?? '', destination, ctx, err);
      this.emit(operation, { source, destination, result: 'failure', message: (err as Error).message, at: new Date().toISOString() }, 'failed');
      throw err;
    }
  }
}
