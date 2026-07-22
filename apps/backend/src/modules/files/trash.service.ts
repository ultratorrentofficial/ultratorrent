import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  DEFAULT_TRASH_RETENTION_DAYS,
  TRASH_RETENTION_DAYS_KEY,
  WS_EVENTS,
  type TrashItemDto,
} from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SettingsService } from '../settings/settings.module';
import { FilePathService, type FileOpContext } from './file-path.service';
import { TRASH_DIR_NAME, type PathSafety } from './path-safety';
import { computeSize, moveRecursive, pathExists, statSafe } from './file-fs.util';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How often the retention sweep runs. Hourly is deliberately coarse: the UI
 * counts down to the exact `expiresAt` locally, so the only thing this cadence
 * controls is how long an already-expired item lingers on disk — and sweeping a
 * media library's trash more often than that buys nothing.
 */
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

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
    private readonly settings: SettingsService,
  ) {}

  private get safety() {
    return this.paths.safety;
  }

  /**
   * Retention window in days; `0` means "keep until purged by hand".
   *
   * Read per call rather than cached so an admin lowering the window takes effect
   * on the next sweep without a restart. A missing/garbage value falls back to the
   * default instead of throwing — a broken setting must not strand the sweep and
   * let trash grow unbounded, nor make it delete on a window nobody chose.
   */
  async retentionDays(): Promise<number> {
    let raw: unknown;
    try {
      raw = await this.settings.get(TRASH_RETENTION_DAYS_KEY);
    } catch (err) {
      this.logger.warn(
        `Could not read ${TRASH_RETENTION_DAYS_KEY}: ${(err as Error).message}`,
      );
      return DEFAULT_TRASH_RETENTION_DAYS;
    }
    if (raw === undefined || raw === null || raw === '') return DEFAULT_TRASH_RETENTION_DAYS;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      this.logger.warn(
        `Ignoring invalid ${TRASH_RETENTION_DAYS_KEY} value ${JSON.stringify(raw)}; using ${DEFAULT_TRASH_RETENTION_DAYS}.`,
      );
      return DEFAULT_TRASH_RETENTION_DAYS;
    }
    return n;
  }

  /** Absolute expiry instant for an item, or `null` when retention is disabled. */
  expiryOf(deletedAt: Date, retentionDays: number): string | null {
    if (retentionDays <= 0) return null;
    return new Date(deletedAt.getTime() + retentionDays * MS_PER_DAY).toISOString();
  }

  /**
   * Permanently remove trash whose retention window has elapsed.
   *
   * This is the ONLY thing that makes the Trash surface honest: it is a live view
   * of what is recoverable, not a history log, so an entry disappearing here is
   * exactly what the operator should see once the payload is gone.
   *
   * Failures are per-item and non-fatal — one undeletable payload (busy mount,
   * permission) must not stop the rest of the sweep. A row whose payload is
   * already missing is still dropped, since it is not recoverable either way.
   */
  async pruneExpired(): Promise<{ removed: number; bytes: number }> {
    const retentionDays = await this.retentionDays();
    if (retentionDays <= 0) return { removed: 0, bytes: 0 };

    const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY);
    const rows = await this.prisma.trashItem.findMany({ where: { deletedAt: { lt: cutoff } } });
    if (!rows.length) return { removed: 0, bytes: 0 };

    let removed = 0;
    let bytes = 0;
    for (const row of rows) {
      try {
        // Same guard as purge(): only ever unlink inside a trash directory, so a
        // corrupted row can never point the sweep at live library content.
        if (this.payloadIsRemovable(row)) {
          await rm(row.trashPath, { recursive: true, force: true });
        }
        await this.prisma.trashItem.delete({ where: { id: row.id } });
        removed++;
        bytes += Number(row.size);
      } catch (err) {
        this.logger.warn(
          `Retention sweep could not remove "${row.trashPath}": ${(err as Error).message}`,
        );
      }
    }

    if (removed > 0) {
      await this.audit.record({
        action: 'file.trash_prune',
        result: 'success',
        metadata: { removed, bytes, retentionDays },
      });
      this.realtime.broadcast(WS_EVENTS.FILES_TRASH_UPDATED, { action: 'pruned', count: removed });
      this.logger.log(
        `Retention sweep removed ${removed} expired trash item(s), reclaiming ${bytes} bytes.`,
      );
    }
    return { removed, bytes };
  }

  @Interval('files_trash_retention_sweep', RETENTION_SWEEP_INTERVAL_MS)
  async sweepExpired(): Promise<void> {
    try {
      await this.pruneExpired();
    } catch (err) {
      this.logger.warn(`Trash retention sweep failed: ${(err as Error).message}`);
    }
  }

  /**
   * Move an already-validated absolute path into its root's trash directory.
   *
   * `safety` defaults to the narrowed browse boundary. A caller performing
   * storage maintenance passes {@link FilePathService.storageSafety} so the item
   * is sited in the hard root that genuinely contains it — otherwise a narrowed
   * Default Root Path makes `rootFor` miss and rejects the file outright.
   */
  async moveToTrash(
    absPath: string,
    ctx: FileOpContext = {},
    safety: PathSafety = this.safety,
  ): Promise<TrashItemDto> {
    safety.assertDeletable(absPath);
    if (safety.isInsideTrash(absPath)) {
      throw new BadRequestException('Item is already in the trash');
    }
    const storageRoot = safety.rootFor(absPath);
    if (!storageRoot) {
      throw new BadRequestException('Item is outside the allowed roots');
    }

    const info = await statSafe(absPath);
    if (!info) throw new NotFoundException('Item not found');

    const name = path.basename(absPath);
    // Same boundary as the containment check above: restore resolves this string
    // again later, so rebasing it against a different root would record a path
    // that no longer round-trips.
    const originalPath = safety.toRelative(absPath);
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
    return this.toDto(row, await this.retentionDays());
  }

  /**
   * Everything currently recoverable, newest first.
   *
   * Rows past their expiry are withheld and a sweep is kicked off: the hourly
   * @{link sweepExpired} is what actually reclaims the disk, but an operator must
   * never see a countdown sitting at zero next to a Restore button that is about
   * to start failing. The list and the countdown agree by construction.
   */
  async list(): Promise<TrashItemDto[]> {
    const retentionDays = await this.retentionDays();
    const rows = await this.prisma.trashItem.findMany({ orderBy: { deletedAt: 'desc' } });
    const now = Date.now();
    const live = rows.filter(
      (r) => retentionDays <= 0 || r.deletedAt.getTime() + retentionDays * MS_PER_DAY > now,
    );
    if (live.length !== rows.length) {
      void this.pruneExpired().catch((err) =>
        this.logger.warn(`Opportunistic trash prune failed: ${(err as Error).message}`),
      );
    }
    return live.map((r) => this.toDto(r, retentionDays));
  }

  /** Restore a trashed item to its original location. Never overwrites silently. */
  async restore(id: string, overwrite = false, ctx: FileOpContext = {}): Promise<{ path: string }> {
    const row = await this.prisma.trashItem.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Trash item not found');

    // Re-validate the original destination against current roots (fail-closed).
    const dest = this.resolveOriginal(row);
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
    return { path: path.posix.join('/', path.relative(row.storageRoot, dest).split(path.sep).join('/')) };
  }

  /**
   * Where a trashed item goes back to.
   *
   * `originalPath` is relative to the root that held the file when it was trashed,
   * and the row records that root — so restore resolves against **that** root, not
   * against `roots[0]` of whatever boundary happens to be asking. Going through
   * `safety.resolveLogical` here was G12: for anything trashed in `storage` scope
   * from outside a narrowed browse root, it rebased the path against the narrowed
   * root and either rejected the restore or, worse, silently put the file back in
   * the wrong place. The recorded root round-trips exactly; there is nothing to guess.
   *
   * Still fail-closed: the recorded root must still be a configured storage root,
   * and the destination must land inside it.
   */
  private resolveOriginal(row: { originalPath: string; storageRoot: string }): string {
    const root = path.resolve(row.storageRoot);
    if (!this.paths.hardRoots.some((r) => root === path.resolve(r) || root.startsWith(path.resolve(r) + path.sep))) {
      throw new BadRequestException(
        'The storage root this item was trashed from is no longer configured; restore it by hand.',
      );
    }
    if (typeof row.originalPath !== 'string' || row.originalPath.includes('\0')) {
      throw new BadRequestException('Invalid original path');
    }
    const dest = path.resolve(root, row.originalPath.replace(/^\/+/, ''));
    if (dest !== root && !dest.startsWith(root + path.sep)) {
      throw new BadRequestException('Refusing to restore outside the item\'s own storage root');
    }
    return dest;
  }

  /**
   * A trashed payload may be removed only from inside a trash directory — checked
   * against the item's OWN recorded root. Asking the narrowed browse boundary
   * (`this.safety`) returned false for anything trashed outside it, so the row was
   * deleted while the payload stayed on disk forever: a silent leak that also made
   * the reclaimed-bytes figure a lie.
   */
  private payloadIsRemovable(row: { trashPath: string; storageRoot: string }): boolean {
    const root = path.resolve(row.storageRoot);
    if (!this.paths.hardRoots.some((r) => root === path.resolve(r) || root.startsWith(path.resolve(r) + path.sep))) {
      return false;
    }
    const trashDir = path.join(root, TRASH_DIR_NAME);
    const resolved = path.resolve(row.trashPath);
    return resolved.startsWith(trashDir + path.sep);
  }

  /** Permanently delete a single trashed item. */
  async purge(id: string, ctx: FileOpContext = {}): Promise<{ ok: true }> {
    const row = await this.prisma.trashItem.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Trash item not found');
    // Only ever remove paths that live inside a trash directory.
    if (this.payloadIsRemovable(row)) {
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
      if (this.payloadIsRemovable(row)) {
        await rm(row.trashPath, { recursive: true, force: true }).catch((e) =>
          this.logger.warn(`Failed to remove ${row.trashPath}: ${(e as Error).message}`),
        );
      } else {
        this.logger.warn(`Leaving ${row.trashPath}: outside any configured storage root`);
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

  private toDto(
    row: {
      id: string;
      originalPath: string;
      name: string;
      isDirectory: boolean;
      size: bigint;
      deletedAt: Date;
      deletedById: string | null;
    },
    retentionDays: number,
  ): TrashItemDto {
    return {
      id: row.id,
      name: row.name,
      originalPath: row.originalPath,
      isDirectory: row.isDirectory,
      size: Number(row.size),
      deletedAt: row.deletedAt.toISOString(),
      deletedBy: row.deletedById,
      expiresAt: this.expiryOf(row.deletedAt, retentionDays),
    };
  }
}
