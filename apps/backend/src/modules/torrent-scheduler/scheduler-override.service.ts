import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EngineRegistryService } from '../engine/engine-registry.service';

/**
 * Per-torrent instructions from an operator.
 *
 * These make capability the planner ALREADY has reachable: it has always
 * honoured `protectedFromPause`, `protectedFromRemoval` and `forceStarted`, and
 * until now nothing could turn any of them on.
 *
 * Four kinds, each answering a different question:
 *
 *  - `protect_from_pause` — the scheduler may not pause it to free a slot.
 *  - `protect_from_removal` — it may not be stopped for meeting a seed target.
 *  - `exclude` — the scheduler ignores it entirely, in both directions.
 *  - `force_start` — run it regardless of limits.
 *
 * `exclude` and the protections overlap but are not the same: a protected
 * torrent still counts toward the limits and can still be resumed by the
 * scheduler, whereas an excluded one is outside its authority altogether.
 */
export const OVERRIDE_KINDS = [
  'protect_from_pause',
  'protect_from_removal',
  'exclude',
  'force_start',
] as const;

export type OverrideKind = (typeof OVERRIDE_KINDS)[number];

export interface OverrideInput {
  kind?: string;
  /** Minutes from now; omitted means until revoked. */
  expiresInMinutes?: number | null;
  reason?: string;
}

@Injectable()
export class SchedulerOverrideService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistryService,
    private readonly audit: AuditService,
  ) {}

  private assertEngine(engineId: string): void {
    try {
      this.registry.get(engineId);
    } catch {
      throw new NotFoundException(`Unknown engine: ${engineId}`);
    }
  }

  /**
   * The overrides actually in force for an engine.
   *
   * Expiry is applied HERE rather than by a cleanup job, so a job that never
   * runs cannot leave an instruction wrongly in force. The clock decides.
   */
  async active(engineId: string, now = new Date()) {
    const rows = await this.prisma.torrentSchedulerOverride.findMany({
      where: {
        engineId,
        clearedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
    const byHash = new Map<string, Set<OverrideKind>>();
    for (const r of rows) {
      const key = r.hash.toLowerCase();
      if (!byHash.has(key)) byHash.set(key, new Set());
      byHash.get(key)!.add(r.kind as OverrideKind);
    }
    return byHash;
  }

  list(engineId: string) {
    this.assertEngine(engineId);
    return this.prisma.torrentSchedulerOverride.findMany({
      where: { engineId, clearedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async set(engineId: string, hash: string, input: OverrideInput, userId?: string) {
    this.assertEngine(engineId);
    const kind = input.kind as OverrideKind;
    if (!OVERRIDE_KINDS.includes(kind)) {
      throw new BadRequestException(
        `Unknown override "${input.kind}". Expected one of: ${OVERRIDE_KINDS.join(', ')}.`,
      );
    }
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{32}$/i.test(hash)) {
      // The hash reaches a provider call eventually; validate its shape rather
      // than trusting whatever a client sent.
      throw new BadRequestException('That does not look like a torrent info-hash.');
    }
    const minutes = input.expiresInMinutes;
    if (minutes != null && (!Number.isInteger(minutes) || minutes < 1)) {
      throw new BadRequestException('An expiry must be a whole number of minutes, at least 1.');
    }
    const expiresAt = minutes != null ? new Date(Date.now() + minutes * 60_000) : null;

    const saved = await this.prisma.torrentSchedulerOverride.upsert({
      where: { engineId_hash_kind: { engineId, hash: hash.toLowerCase(), kind } },
      create: {
        engineId, hash: hash.toLowerCase(), kind, expiresAt,
        reason: input.reason ?? null, createdBy: userId ?? null,
      },
      // Re-applying refreshes it and revives one that was revoked, rather than
      // failing on the unique key or leaving a cleared row shadowing the new one.
      update: { expiresAt, reason: input.reason ?? null, createdBy: userId ?? null, clearedAt: null },
    });

    await this.audit.record({
      userId,
      action: 'torrent_scheduler.override_set',
      objectType: 'torrent',
      objectId: hash,
      result: 'success',
      metadata: { engineId, kind, expiresAt },
    });
    return saved;
  }

  async clear(engineId: string, hash: string, kind: string, userId?: string) {
    this.assertEngine(engineId);
    await this.prisma.torrentSchedulerOverride.updateMany({
      where: { engineId, hash: hash.toLowerCase(), kind, clearedAt: null },
      data: { clearedAt: new Date() },
    });
    await this.audit.record({
      userId,
      action: 'torrent_scheduler.override_cleared',
      objectType: 'torrent',
      objectId: hash,
      result: 'success',
      metadata: { engineId, kind },
    });
    return { cleared: true };
  }
}
