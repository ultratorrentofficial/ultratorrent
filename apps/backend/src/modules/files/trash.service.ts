import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { WS_EVENTS, type TrashItemDto } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { FilePathService, type FileOpContext } from './file-path.service';
import { TRASH_DIR_NAME } from './path-safety';
import { computeSize, moveRecursive, pathExists, statSafe } from './file-fs.util';

/**
 * Soft-delete (Trash) manager. Moves deleted items into a `.ultratorrent-trash`
 * directory inside their own storage root and records a {@link TrashItem} row so
 * the Trash Browser can list, restore-to-original, and empty. Restores never
 * overwrite without explicit confirmation.
 */
@Injectable()
export class TrashService {
  private readonly logger = new Logger(TrashService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paths: FilePathService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private get safety() {
    return this.paths.safety;
  }

  /** Move an already-validated absolute path into its root's trash directory. */
  async moveToTrash(absPath: string, ctx: FileOpContext = {}): Promise<TrashItemDto> {
    this.safety.assertDeletable(absPath);
    if (this.safety.isInsideTrash(absPath)) {
      throw new BadRequestException('Item is already in the trash');
    }
    const storageRoot = this.safety.rootFor(absPath);
    if (!storageRoot) {
      throw new BadRequestException('Item is outside the allowed roots');
    }

    const info = await statSafe(absPath);
    if (!info) throw new NotFoundException('Item not found');

    const name = path.basename(absPath);
    const originalPath = this.safety.toRelative(absPath);
    const trashDir = path.join(storageRoot, TRASH_DIR_NAME);
    await mkdir(trashDir, { recursive: true });

    // Unique on-disk name so identical basenames never collide in the trash.
    const id = randomUUID();
    const trashPath = path.join(trashDir, `${id}__${name}`);
    const size = await computeSize(absPath);

    await moveRecursive(absPath, trashPath, false);

    const row = await this.prisma.trashItem.create({
      data: {
        id,
        originalPath,
        name,
        trashPath,
        storageRoot,
        isDirectory: info.isDirectory(),
        size: BigInt(size),
        deletedById: ctx.userId ?? null,
      },
    });

    await this.audit.record({
      userId: ctx.userId,
      action: 'file.deleted',
      objectType: 'file',
      objectId: originalPath,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { mode: 'trash', isDirectory: info.isDirectory(), bytes: size },
    });
    this.realtime.broadcast(WS_EVENTS.FILES_TRASH_UPDATED, { action: 'added', id: row.id });
    return this.toDto(row);
  }

  async list(): Promise<TrashItemDto[]> {
    const rows = await this.prisma.trashItem.findMany({ orderBy: { deletedAt: 'desc' } });
    return rows.map((r) => this.toDto(r));
  }

  /** Restore a trashed item to its original location. Never overwrites silently. */
  async restore(id: string, overwrite = false, ctx: FileOpContext = {}): Promise<{ path: string }> {
    const row = await this.prisma.trashItem.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Trash item not found');

    // Re-validate the original destination against current roots (fail-closed).
    const dest = this.safety.resolveLogical(row.originalPath);
    if (!(await pathExists(row.trashPath))) {
      // The on-disk payload vanished — drop the dangling record.
      await this.prisma.trashItem.delete({ where: { id } }).catch(() => undefined);
      throw new NotFoundException('Trashed payload no longer exists on disk');
    }
    if (!overwrite && (await pathExists(dest))) {
      throw new ConflictException('An item already exists at the original location');
    }
    if (overwrite && (await pathExists(dest))) {
      await rm(dest, { recursive: true, force: true });
    }

    await moveRecursive(row.trashPath, dest, overwrite);
    await this.prisma.trashItem.delete({ where: { id } });

    await this.audit.record({
      userId: ctx.userId,
      action: 'file.restore',
      objectType: 'file',
      objectId: row.originalPath,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { bytes: Number(row.size) },
    });
    this.realtime.broadcast(WS_EVENTS.FILES_TRASH_UPDATED, { action: 'restored', id });
    return { path: this.safety.toRelative(dest) };
  }

  /** Permanently delete a single trashed item. */
  async purge(id: string, ctx: FileOpContext = {}): Promise<{ ok: true }> {
    const row = await this.prisma.trashItem.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Trash item not found');
    // Only ever remove paths that live inside a trash directory.
    if (this.safety.isInsideTrash(row.trashPath)) {
      await rm(row.trashPath, { recursive: true, force: true });
    }
    await this.prisma.trashItem.delete({ where: { id } });
    await this.audit.record({
      userId: ctx.userId,
      action: 'file.deleted',
      objectType: 'file',
      objectId: row.originalPath,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { mode: 'permanent', from: 'trash', bytes: Number(row.size) },
    });
    this.realtime.broadcast(WS_EVENTS.FILES_TRASH_UPDATED, { action: 'purged', id });
    return { ok: true };
  }

  /** Empty the trash entirely (all roots). */
  async empty(ctx: FileOpContext = {}): Promise<{ removed: number; bytes: number }> {
    const rows = await this.prisma.trashItem.findMany();
    let bytes = 0;
    for (const row of rows) {
      if (this.safety.isInsideTrash(row.trashPath)) {
        await rm(row.trashPath, { recursive: true, force: true }).catch((e) =>
          this.logger.warn(`Failed to remove ${row.trashPath}: ${(e as Error).message}`),
        );
      }
      bytes += Number(row.size);
    }
    await this.prisma.trashItem.deleteMany({});

    await this.audit.record({
      userId: ctx.userId,
      action: 'file.trash_empty',
      result: 'success',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { removed: rows.length, bytes },
    });
    this.realtime.broadcast(WS_EVENTS.FILES_TRASH_UPDATED, { action: 'emptied', count: rows.length });
    return { removed: rows.length, bytes };
  }

  private toDto(row: {
    id: string;
    originalPath: string;
    name: string;
    isDirectory: boolean;
    size: bigint;
    deletedAt: Date;
    deletedById: string | null;
  }): TrashItemDto {
    return {
      id: row.id,
      name: row.name,
      originalPath: row.originalPath,
      isDirectory: row.isDirectory,
      size: Number(row.size),
      deletedAt: row.deletedAt.toISOString(),
      deletedBy: row.deletedById,
    };
  }
}
