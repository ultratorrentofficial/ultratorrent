import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { Response } from 'express';
import {
  WS_EVENTS,
  type BrowseResponse,
  type FileNode,
  type FileOperationEventPayload,
  type FileOperationResult,
  type FileOperationType,
  type FilePropertiesResponse,
} from '@ultratorrent/shared';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { FilePathService, type FileOpContext } from './file-path.service';
import { TRASH_DIR_NAME, assertSafeName } from './path-safety';
import {
  computeSize,
  copyRecursive,
  countItems,
  moveRecursive,
  pathExists,
  statSafe,
} from './file-fs.util';
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

@Injectable()
export class FilesService {
  constructor(
    private readonly paths: FilePathService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    private readonly trash: TrashService,
  ) {}

  private get safety() {
    return this.paths.safety;
  }

  // --- read ----------------------------------------------------------------

  async browse(requested: string): Promise<BrowseResponse> {
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

  async preview(requested: string, maxBytes = 256 * 1024) {
    const target = await this.safety.resolveExisting(requested);
    const info = await stat(target);
    if (info.isDirectory()) throw new BadRequestException('Cannot preview a directory');
    if (info.size > maxBytes) throw new BadRequestException('File too large to preview');
    const content = await readFile(target, 'utf8');
    return { path: this.safety.toRelative(target), content };
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

  async remove(dto: DeleteFileDto, ctx: FileOpContext = {}): Promise<FileOperationResult> {
    let rel = dto.path;
    this.emit('delete', { source: rel, at: new Date().toISOString() }, 'started');
    try {
      const target = await this.safety.resolveExisting(dto.path);
      this.safety.assertDeletable(target);
      rel = this.safety.toRelative(target);
      if (dto.permanent) {
        if (!(await pathExists(target))) throw new NotFoundException('Item not found');
        const bytes = await computeSize(target);
        await rm(target, { recursive: true, force: true });
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
      // Trash mode (audits + emits trash.updated inside the trash service).
      const item = await this.trash.moveToTrash(target, ctx);
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
    const destDir = this.safety.resolveLogical(dto.destination);
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
            await this.remove({ path: p, permanent: dto.permanent }, ctx);
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
