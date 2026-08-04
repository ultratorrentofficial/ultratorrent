import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { SchedulingPolicyScopeType } from './domain/policy';

const SCOPE_TYPES: SchedulingPolicyScopeType[] = [
  'global', 'engine', 'library', 'category', 'rss_rule', 'torrent',
];

export interface PolicyInput {
  name?: string;
  enabled?: boolean;
  scopeType?: string;
  scopeId?: string | null;
  maxConcurrentDownloads?: number | null;
  maxConcurrentSeeds?: number | null;
  maxTotalActive?: number | null;
  seedPolicy?: {
    mode?: string;
    targetRatio?: number | null;
    afterTarget?: string;
    requireImportCompleted?: boolean;
    requireLibraryCopyVerified?: boolean;
  } | null;
}

/**
 * Only what can actually be enforced today.
 *
 * `time`, `ratio_or_time` and `ratio_and_time` are absent because nothing
 * records seed duration on either shipped engine, so such a policy could never
 * be evaluated — it would sit in the database looking configured and do nothing.
 * The two removal actions are absent for a different reason: taking a payload
 * away has to pass Media Intake's ownership and path-safety checks, which the
 * scheduler does not own.
 */
const SEED_MODES = ['ratio', 'manual', 'unlimited'];
const AFTER_TARGET = ['pause', 'stop', 'leave_active'];

/**
 * Scheduling policies: create, edit, delete.
 *
 * Only the three concurrency limits are writable. Bandwidth and seeding fields
 * exist in the schema for the phases that will enforce them, and offering them
 * now would let an operator set a rate limit nothing applies — the same failure
 * as a permission that guards nothing, except this one silently does nothing to
 * their queue while appearing to be configured.
 *
 * A limit is one of three things, and the API keeps them distinct because the
 * resolver depends on it: absent means inherit from the scope above, `null`
 * means explicitly unlimited and stops inheritance, and a number is a cap.
 */
@Injectable()
export class SchedulerPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.torrentSchedulerPolicy.findMany({
      orderBy: [{ scopeType: 'asc' }, { name: 'asc' }],
    });
  }

  async get(id: string) {
    const found = await this.prisma.torrentSchedulerPolicy.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('Policy not found');
    return found;
  }

  /**
   * A limit must be a positive whole number, explicitly unlimited, or absent.
   *
   * Zero is rejected on purpose. "Allow zero downloads" reads like a way to stop
   * the queue, but it is indistinguishable from a misconfiguration and would
   * pause every torrent on the engine — if an operator wants that, pausing is
   * the honest verb, not a limit of nought.
   */
  private limit(value: unknown, field: string): number | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new BadRequestException(
        `${field} must be a whole number of at least 1, or empty for unlimited.`,
      );
    }
    return value;
  }

  private seed(input: PolicyInput['seedPolicy']): object | null | undefined {
    if (input === undefined) return undefined;
    if (input === null) return null;

    const mode = input.mode ?? 'ratio';
    if (!SEED_MODES.includes(mode)) {
      throw new BadRequestException(
        `Seeding mode "${mode}" cannot be enforced yet. Available: ${SEED_MODES.join(', ')}.`,
      );
    }
    const afterTarget = input.afterTarget ?? 'pause';
    if (!AFTER_TARGET.includes(afterTarget)) {
      throw new BadRequestException(
        `Post-target action "${afterTarget}" is not available. Available: ${AFTER_TARGET.join(', ')}.`,
      );
    }
    if (mode === 'ratio') {
      const r = input.targetRatio;
      if (typeof r !== 'number' || !(r > 0)) {
        throw new BadRequestException('A ratio target needs a share ratio greater than zero.');
      }
    }
    return {
      mode,
      afterTarget,
      ...(input.targetRatio != null ? { targetRatio: input.targetRatio } : {}),
      ...(input.requireImportCompleted ? { requireImportCompleted: true } : {}),
      ...(input.requireLibraryCopyVerified ? { requireLibraryCopyVerified: true } : {}),
    };
  }

  private validateScope(scopeType: string, scopeId: string | null | undefined): void {
    if (!SCOPE_TYPES.includes(scopeType as SchedulingPolicyScopeType)) {
      throw new BadRequestException(
        `Unknown scope "${scopeType}". Expected one of: ${SCOPE_TYPES.join(', ')}.`,
      );
    }
    if (scopeType === 'global') {
      if (scopeId) throw new BadRequestException('A global policy cannot name a scope id.');
      return;
    }
    if (!scopeId) {
      throw new BadRequestException(`A ${scopeType} policy must name what it applies to.`);
    }
  }

  async create(input: PolicyInput, userId?: string) {
    const name = (input.name ?? '').trim();
    if (!name) throw new BadRequestException('A policy needs a name.');
    const scopeType = input.scopeType ?? 'global';
    // Validate what the caller SENT, before normalising. Nulling a stray scope id
    // first would silently accept a contradiction — "global, but only for this
    // library" — and leave the operator believing it had been honoured.
    this.validateScope(scopeType, input.scopeId ?? null);
    const scopeId = scopeType === 'global' ? null : (input.scopeId ?? null);

    const created = await this.prisma.torrentSchedulerPolicy.create({
      data: {
        name,
        enabled: input.enabled ?? true,
        scopeType,
        scopeId,
        maxConcurrentDownloads: this.limit(input.maxConcurrentDownloads, 'maxConcurrentDownloads') ?? null,
        maxConcurrentSeeds: this.limit(input.maxConcurrentSeeds, 'maxConcurrentSeeds') ?? null,
        maxTotalActive: this.limit(input.maxTotalActive, 'maxTotalActive') ?? null,
        seedPolicy: this.seed(input.seedPolicy) ?? undefined,
        createdBy: userId ?? null,
      },
    });

    await this.audit.record({
      userId,
      action: 'torrent_scheduler.policy_created',
      objectType: 'torrent_scheduler_policy',
      objectId: created.id,
      result: 'success',
      metadata: { name, scopeType, scopeId },
    });
    return created;
  }

  async update(id: string, input: PolicyInput, userId?: string) {
    await this.get(id);

    if (input.scopeType !== undefined) {
      this.validateScope(input.scopeType, input.scopeId ?? null);
    }

    const updated = await this.prisma.torrentSchedulerPolicy.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.scopeType !== undefined ? { scopeType: input.scopeType } : {}),
        ...(input.scopeId !== undefined ? { scopeId: input.scopeId } : {}),
        // `undefined` is omitted by Prisma, which is exactly the inherit case;
        // `null` is written, which is the explicit-unlimited case.
        maxConcurrentDownloads: this.limit(input.maxConcurrentDownloads, 'maxConcurrentDownloads'),
        maxConcurrentSeeds: this.limit(input.maxConcurrentSeeds, 'maxConcurrentSeeds'),
        maxTotalActive: this.limit(input.maxTotalActive, 'maxTotalActive'),
        // `DbNull` is how Prisma clears a nullable JSON column; a bare `null`
        // is rejected because it is ambiguous with JSON's own null literal.
        seedPolicy: (() => {
          const next = this.seed(input.seedPolicy);
          if (next === undefined) return undefined;
          return next === null ? Prisma.DbNull : next;
        })(),
      },
    });

    await this.audit.record({
      userId,
      action: 'torrent_scheduler.policy_updated',
      objectType: 'torrent_scheduler_policy',
      objectId: id,
      result: 'success',
      metadata: { name: updated.name },
    });
    return updated;
  }

  async remove(id: string, userId?: string) {
    const policy = await this.get(id);
    await this.prisma.torrentSchedulerPolicy.delete({ where: { id } });
    await this.audit.record({
      userId,
      action: 'torrent_scheduler.policy_deleted',
      objectType: 'torrent_scheduler_policy',
      objectId: id,
      result: 'success',
      metadata: { name: policy.name },
    });
    return { deleted: true };
  }
}
