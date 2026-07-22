import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NOTIFICATION_BUS_CHANNEL, PERMISSIONS } from '@ultratorrent/shared';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { paginate, parsePage } from '../../../common/pagination';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { evaluateProtections, type ProtectionRecord, type ProtectionTarget } from './domain/protection-matcher';
import type { BulkCreateProtectionDto, CreateProtectionDto, ProtectionListQueryDto } from './dto/protection.dto';

/** Which id a target type is meaningless without. */
const REQUIRED_FIELD: Record<string, keyof CreateProtectionDto | null> = {
  media_file: 'mediaFileId',
  media_item: 'mediaItemId',
  show: 'mediaShowId',
  season: 'mediaShowId',
  episode: 'mediaShowId',
  library: 'mediaLibraryId',
  path_prefix: 'pathPrefix',
  tag: 'tagValue',
  collection: 'collectionId',
  torrent: 'torrentHash',
  external_identity: 'externalIdentityKey',
  watchlist: null, // scope is "anything on a watchlist" — no id needed
};

const SWEEP_MS = 6 * 60 * 60 * 1000; // 6h
const EXPIRY_WARN_DAYS = 7;

/**
 * The Protection Registry.
 *
 * Protection is an ABSOLUTE exclusion for automation, so this service is
 * deliberately boring: it stores rules, it never deletes them (removal is a
 * revocation, so the history stays auditable), and the decision of whether a rule
 * covers a target lives in the pure {@link evaluateProtections} matcher, which the
 * executor re-runs immediately before touching a file.
 */
@Injectable()
export class ProtectionService {
  private readonly logger = new Logger(ProtectionService.name);
  /** Only announce expiries that crossed since the last sweep, so a tick is quiet. */
  private lastSweepAt = new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly eventBus: EventEmitter2,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────
  async list(query: ProtectionListQueryDto) {
    const params = parsePage(query.page, query.pageSize, 25, 200);
    const where: Record<string, unknown> = {};
    if (query.targetType) where.targetType = query.targetType;
    if (query.protectionType) where.protectionType = query.protectionType;
    if (query.activeOnly !== false) {
      where.revokedAt = null;
      where.OR = [{ protectedUntil: null }, { protectedUntil: { gt: new Date() } }];
    }
    if (query.search) where.reason = { contains: query.search, mode: 'insensitive' };
    return paginate(this.prisma.mediaCleanupProtection, { where, orderBy: { createdAt: 'desc' } }, params);
  }

  async get(id: string) {
    const row = await this.prisma.mediaCleanupProtection.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Protection not found');
    return row;
  }

  /** Protections lapsing soon — the operator's chance to renew before cleanup can act. */
  async expiring(withinDays = EXPIRY_WARN_DAYS) {
    const now = new Date();
    const until = new Date(now.getTime() + withinDays * 86_400_000);
    return this.prisma.mediaCleanupProtection.findMany({
      where: { revokedAt: null, protectedUntil: { not: null, gt: now, lte: until } },
      orderBy: { protectedUntil: 'asc' },
      take: 200,
    });
  }

  /**
   * The question cleanup actually asks. Loads the candidate rules narrowly and
   * delegates the decision to the pure matcher.
   */
  async evaluate(target: ProtectionTarget, now = new Date()) {
    const rows = await this.prisma.mediaCleanupProtection.findMany({
      where: {
        revokedAt: null,
        OR: [{ protectedUntil: null }, { protectedUntil: { gt: now } }],
      },
      take: 5000,
    });
    return evaluateProtections(target, rows as unknown as ProtectionRecord[], now);
  }

  // ── Writes ─────────────────────────────────────────────────────────────────
  async create(dto: CreateProtectionDto, user: AuthenticatedUser) {
    this.assertShape(dto);
    this.assertMayUseLegalHold(dto.protectionType, user);

    const row = await this.prisma.mediaCleanupProtection.create({
      data: {
        targetType: dto.targetType,
        protectionType: dto.protectionType,
        reason: dto.reason,
        mediaItemId: dto.mediaItemId ?? null,
        mediaFileId: dto.mediaFileId ?? null,
        mediaShowId: dto.mediaShowId ?? null,
        mediaLibraryId: dto.mediaLibraryId ?? null,
        seasonNumber: dto.seasonNumber ?? null,
        episodeNumber: dto.episodeNumber ?? null,
        externalIdentityKey: dto.externalIdentityKey ?? null,
        pathPrefix: dto.pathPrefix ?? null,
        tagValue: dto.tagValue ?? null,
        collectionId: dto.collectionId ?? null,
        torrentHash: dto.torrentHash ?? null,
        protectedUntil: dto.protectedUntil ? new Date(dto.protectedUntil) : null,
        conditionKind: dto.conditionKind ?? null,
        conditionConfig: (dto.conditionConfig ?? undefined) as object | undefined,
        createdByUserId: user.id,
      },
    });

    await this.audit.record({
      userId: user.id,
      action: dto.protectionType === 'legal_hold'
        ? 'library_cleanup.protection.legal_hold_created'
        : 'library_cleanup.protection.created',
      objectType: 'media_cleanup_protection',
      objectId: row.id,
      metadata: { targetType: dto.targetType, protectionType: dto.protectionType, reason: dto.reason },
    });
    this.emit('media.cleanup.protection.created', {
      protectionId: row.id, targetType: row.targetType, protectionType: row.protectionType,
    });
    return row;
  }

  async bulkCreate(dto: BulkCreateProtectionDto, user: AuthenticatedUser) {
    const created: string[] = [];
    const failed: Array<{ index: number; error: string }> = [];
    // Each is independent: one bad entry must not silently drop the rest, and a
    // caller must be able to see exactly which ones did not take.
    for (const [i, p] of dto.protections.entries()) {
      try {
        const row = await this.create(p, user);
        created.push(row.id);
      } catch (err) {
        failed.push({ index: i, error: (err as Error).message });
      }
    }
    return { created: created.length, failed, protectionIds: created };
  }

  /**
   * Revocation, not deletion — the row stays so the audit history survives.
   * Lifting a legal hold needs the legal-hold permission, re-checked here rather
   * than trusting the route guard alone.
   */
  async revoke(id: string, reason: string, user: AuthenticatedUser) {
    const row = await this.get(id);
    if (row.revokedAt) throw new BadRequestException('Protection is already revoked');
    this.assertMayUseLegalHold(row.protectionType, user);

    const updated = await this.prisma.mediaCleanupProtection.update({
      where: { id },
      data: { revokedAt: new Date(), revokedByUserId: user.id, revokeReason: reason },
    });
    await this.audit.record({
      userId: user.id,
      action: row.protectionType === 'legal_hold'
        ? 'library_cleanup.protection.legal_hold_revoked'
        : 'library_cleanup.protection.revoked',
      objectType: 'media_cleanup_protection',
      objectId: id,
      metadata: { targetType: row.targetType, protectionType: row.protectionType, reason },
    });
    this.emit('media.cleanup.protection.revoked', { protectionId: id, reason });
    return updated;
  }

  // ── Expiry sweep ───────────────────────────────────────────────────────────
  /**
   * A temporary protection lapses by time alone — the matcher already ignores it —
   * so this sweep exists to ANNOUNCE the transition, not to cause it. Only
   * protections whose deadline crossed since the previous tick are announced, so a
   * restart does not replay a backlog and a quiet period stays quiet.
   */
  @Interval('library_cleanup_protection_expiry', SWEEP_MS)
  async sweepExpiry(): Promise<void> {
    const now = new Date();
    const since = this.lastSweepAt;
    this.lastSweepAt = now;
    try {
      const justExpired = await this.prisma.mediaCleanupProtection.findMany({
        where: { revokedAt: null, protectedUntil: { not: null, gt: since, lte: now } },
        select: { id: true, targetType: true, protectionType: true },
        take: 500,
      });
      for (const p of justExpired) {
        this.emit('media.cleanup.protection.expired', {
          protectionId: p.id, targetType: p.targetType, protectionType: p.protectionType,
        });
        await this.audit.record({
          action: 'library_cleanup.protection.expired',
          objectType: 'media_cleanup_protection', objectId: p.id,
        });
      }

      const soon = await this.expiring(EXPIRY_WARN_DAYS);
      if (soon.length) {
        this.emit('media.cleanup.protection.expiring', { count: soon.length, withinDays: EXPIRY_WARN_DAYS });
      }
      if (justExpired.length) {
        this.logger.log(`${justExpired.length} protection(s) lapsed since the last sweep`);
      }
    } catch (err) {
      this.logger.error(`Protection expiry sweep failed: ${(err as Error).message}`);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────
  /** A protection whose scope field is missing would silently protect nothing. */
  private assertShape(dto: CreateProtectionDto): void {
    const required = REQUIRED_FIELD[dto.targetType];
    if (required && !dto[required]) {
      throw new BadRequestException(`targetType "${dto.targetType}" requires "${String(required)}"`);
    }
    if (dto.targetType === 'season' && dto.seasonNumber == null) {
      throw new BadRequestException('A season protection requires seasonNumber');
    }
    if (dto.targetType === 'episode' && (dto.seasonNumber == null || dto.episodeNumber == null)) {
      throw new BadRequestException('An episode protection requires seasonNumber and episodeNumber');
    }
    if (dto.protectionType === 'temporary' && !dto.protectedUntil) {
      throw new BadRequestException('A temporary protection requires protectedUntil');
    }
    if (dto.protectedUntil && new Date(dto.protectedUntil).getTime() <= Date.now()) {
      throw new BadRequestException('protectedUntil must be in the future');
    }
    if (dto.protectionType === 'conditional' && !dto.conditionKind) {
      throw new BadRequestException('A conditional protection requires conditionKind');
    }
    if (dto.pathPrefix && !dto.pathPrefix.startsWith('/')) {
      throw new BadRequestException('pathPrefix must be absolute');
    }
  }

  /** Defense in depth: the route guard is not the only check. */
  private assertMayUseLegalHold(protectionType: string, user: AuthenticatedUser): void {
    if (protectionType !== 'legal_hold') return;
    const held = new Set(user.permissions ?? []);
    if (!held.has(PERMISSIONS.LIBRARY_CLEANUP_PROTECTION_LEGAL_HOLD)) {
      throw new ForbiddenException('A legal hold requires library_cleanup.protection.legal_hold');
    }
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    try {
      this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, { event, payload, at: new Date().toISOString() });
    } catch (err) {
      this.logger.debug(`emit ${event} failed: ${(err as Error).message}`);
    }
  }
}
