import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { paginate, parsePage } from '../../../common/pagination';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { FilePathService } from '../../files/file-path.service';
import { moveRecursive, pathExists, computeSize } from '../../files/file-fs.util';
import { ProtectionService } from './protection.service';

/**
 * The reserved directory quarantine moves into. A dotted name so a media scanner
 * ignores it, and sited inside the storage root that already holds the file so the
 * move never crosses a filesystem — a cross-device copy of a 60 GiB remux is not a
 * "quarantine", it is an outage.
 */
export const QUARANTINE_DIR_NAME = '.ultratorrent-quarantine';

/** How often expired quarantine items are considered for purge. */
const SWEEP_MS = 60 * 60 * 1000;

/**
 * Quarantine — a holding area, not a deletion.
 *
 * A quarantined file is moved (never copied, never removed) to a reserved directory
 * inside its own storage root, with its original path, size and fingerprint
 * recorded so it can be put back exactly where it came from. It leaves quarantine
 * only by being restored or by a deliberate purge after its deadline.
 *
 * Purge is the one genuinely irreversible step in the whole subsystem, so it
 * re-checks protection immediately beforehand: a protection placed while an item
 * sat in quarantine must save it.
 */
@Injectable()
export class QuarantineService {
  private readonly logger = new Logger(QuarantineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly paths: FilePathService,
    private readonly protections: ProtectionService,
  ) {}

  /**
   * Move a file into quarantine. `absPath` must already have been validated by the
   * caller; it is validated again here, because this is the last code that runs
   * before the filesystem does.
   */
  async quarantine(input: {
    absPath: string;
    fingerprint: string;
    actionId?: string;
    planId?: string;
    runId?: string;
    policyVersionId?: string;
    mediaItemId?: string | null;
    mediaFileId?: string | null;
    retentionDays?: number | null;
    userId?: string;
  }): Promise<{ id: string; quarantinePath: string; bytes: number }> {
    const safety = this.paths.storageSafety;
    const abs = this.paths.assertWithinHardRoots(input.absPath);
    safety.assertDeletable(abs);

    const storageRoot = safety.rootFor(abs);
    if (!storageRoot) throw new BadRequestException('File is outside the allowed storage roots');
    if (!(await pathExists(abs))) throw new NotFoundException('File no longer exists');

    const bytes = await computeSize(abs);
    const dir = path.join(storageRoot, QUARANTINE_DIR_NAME);
    await mkdir(dir, { recursive: true });

    // UUID-prefixed exactly like TrashService, so two files with the same basename
    // from different shows cannot collide and silently overwrite one another.
    const id = randomUUID();
    const quarantinePath = path.join(dir, `${id}__${path.basename(abs)}`);
    const originalPath = safety.toRelative(abs);

    // Journal BEFORE the move, mirroring duplicate resolution: a crash between the
    // write and the move leaves a row pointing at a file that is still in place,
    // which is recoverable. The reverse leaves a moved file nothing records.
    const row = await this.prisma.mediaCleanupQuarantineItem.create({
      data: {
        id,
        actionId: input.actionId ?? null,
        planId: input.planId ?? null,
        runId: input.runId ?? null,
        policyVersionId: input.policyVersionId ?? null,
        mediaItemId: input.mediaItemId ?? null,
        mediaFileId: input.mediaFileId ?? null,
        originalPath,
        quarantinePath,
        storageRoot,
        fileSizeBytes: BigInt(bytes),
        fingerprint: input.fingerprint,
        status: 'quarantined',
        restoreDeadline: input.retentionDays
          ? new Date(Date.now() + input.retentionDays * 86_400_000)
          : null,
      },
    });

    try {
      await moveRecursive(abs, quarantinePath, false);
    } catch (err) {
      // The move failed, so the file is still where it was. Drop the row rather
      // than leave a record claiming a quarantine that never happened.
      await this.prisma.mediaCleanupQuarantineItem.delete({ where: { id } }).catch(() => undefined);
      throw err;
    }

    await this.audit.record({
      userId: input.userId,
      action: 'library_cleanup.quarantine.added',
      objectType: 'media_cleanup_quarantine_item', objectId: id,
      metadata: { originalPath, bytes, planId: input.planId ?? null },
    });
    return { id: row.id, quarantinePath, bytes };
  }

  async list(query: { page?: number; pageSize?: number; status?: string; planId?: string }) {
    const params = parsePage(query.page, query.pageSize, 50, 200);
    const where: Record<string, unknown> = { status: query.status ?? 'quarantined' };
    if (query.planId) where.planId = query.planId;
    return paginate(this.prisma.mediaCleanupQuarantineItem, { where, orderBy: { quarantinedAt: 'desc' } }, params);
  }

  async get(id: string) {
    const row = await this.prisma.mediaCleanupQuarantineItem.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Quarantine item not found');
    return row;
  }

  /**
   * Put a quarantined file back exactly where it came from.
   *
   * The destination is resolved against the item's OWN recorded storage root — the
   * same lesson as G12 in the Trash service. Never overwrites without being told to.
   */
  async restore(id: string, user: AuthenticatedUser, overwrite = false) {
    const row = await this.get(id);
    if (row.status !== 'quarantined') {
      throw new BadRequestException(`Item is ${row.status} and cannot be restored`);
    }

    const dest = this.resolveOriginal(row);
    if (!(await pathExists(row.quarantinePath))) {
      await this.prisma.mediaCleanupQuarantineItem.update({
        where: { id }, data: { status: 'purged', purgedAt: new Date() },
      });
      throw new NotFoundException('The quarantined file is no longer on disk');
    }
    if (await pathExists(dest)) {
      // Something occupies the original path — very often the replacement that
      // justified the cleanup. Overwriting it silently would undo the operator's
      // actual intent, so this needs saying out loud.
      if (!overwrite) throw new ConflictException('Something already exists at the original location');
      await rm(dest, { recursive: true, force: true });
    }

    await mkdir(path.dirname(dest), { recursive: true });
    await moveRecursive(row.quarantinePath, dest, overwrite);
    const updated = await this.prisma.mediaCleanupQuarantineItem.update({
      where: { id },
      data: { status: 'restored', restoredAt: new Date(), restoredById: user.id },
    });

    await this.audit.record({
      userId: user.id, action: 'library_cleanup.quarantine.restored',
      objectType: 'media_cleanup_quarantine_item', objectId: id,
      metadata: { restoredTo: dest, bytes: Number(row.fileSizeBytes) },
    });
    return updated;
  }

  /**
   * Irreversibly remove a quarantined file. The only step in the subsystem with no
   * way back, so protection is re-checked immediately beforehand — a protection
   * placed while the item sat here must save it.
   */
  async purge(id: string, user: AuthenticatedUser) {
    const row = await this.get(id);
    if (row.status !== 'quarantined') {
      throw new BadRequestException(`Item is ${row.status} and cannot be purged`);
    }

    const verdict = await this.protections.evaluate({
      mediaItemId: row.mediaItemId ?? undefined,
      mediaFileId: row.mediaFileId ?? undefined,
      path: row.originalPath,
    });
    if (verdict.isProtected) {
      await this.audit.record({
        userId: user.id, action: 'library_cleanup.quarantine.purge_refused',
        objectType: 'media_cleanup_quarantine_item', objectId: id, result: 'failure',
        metadata: { reason: verdict.hasLegalHold ? 'legal_hold' : 'protected' },
      });
      throw new BadRequestException(
        verdict.hasLegalHold
          ? 'This item is under a legal hold and cannot be purged'
          : 'This item is protected and cannot be purged',
      );
    }

    if (!this.payloadIsRemovable(row)) {
      throw new BadRequestException('Refusing to remove a path outside a quarantine directory');
    }
    await rm(row.quarantinePath, { recursive: true, force: true });
    const updated = await this.prisma.mediaCleanupQuarantineItem.update({
      where: { id }, data: { status: 'purged', purgedAt: new Date(), purgedById: user.id },
    });

    await this.audit.record({
      userId: user.id, action: 'library_cleanup.quarantine.purged',
      objectType: 'media_cleanup_quarantine_item', objectId: id,
      metadata: { originalPath: row.originalPath, bytes: Number(row.fileSizeBytes) },
    });
    return updated;
  }

  /**
   * Mark items whose restore deadline has passed. Deliberately does NOT delete
   * anything: reaching a deadline means "no longer promised", not "destroy now".
   * A human (or an explicitly-permissioned purge) removes it.
   */
  @Interval('library_cleanup_quarantine_expiry', SWEEP_MS)
  async sweepExpired(): Promise<void> {
    try {
      const now = new Date();
      const due = await this.prisma.mediaCleanupQuarantineItem.updateMany({
        where: { status: 'quarantined', restoreDeadline: { not: null, lte: now } },
        data: { status: 'expired' },
      });
      if (due.count) this.logger.log(`${due.count} quarantine item(s) passed their restore deadline`);
    } catch (err) {
      this.logger.error(`Quarantine expiry sweep failed: ${(err as Error).message}`);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private rootIsConfigured(storageRoot: string): boolean {
    const root = path.resolve(storageRoot);
    return this.paths.hardRoots.some(
      (r) => root === path.resolve(r) || root.startsWith(path.resolve(r) + path.sep),
    );
  }

  private resolveOriginal(row: { originalPath: string; storageRoot: string }): string {
    const root = path.resolve(row.storageRoot);
    if (!this.rootIsConfigured(root)) {
      throw new BadRequestException(
        'The storage root this item came from is no longer configured; restore it by hand.',
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

  /** Only ever unlink inside a quarantine directory, so a corrupted row cannot aim at live content. */
  private payloadIsRemovable(row: { quarantinePath: string; storageRoot: string }): boolean {
    if (!this.rootIsConfigured(row.storageRoot)) return false;
    const dir = path.join(path.resolve(row.storageRoot), QUARANTINE_DIR_NAME);
    return path.resolve(row.quarantinePath).startsWith(dir + path.sep);
  }
}
