import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  LIFECYCLE_COMPLETENESS_INTENTS,
  LIFECYCLE_POLICY_MODES,
  LIFECYCLE_QUALITY_INTENTS,
  LIFECYCLE_SCOPE_TYPES,
  type LifecycleScopeType,
  type MediaLifecyclePolicy,
} from '@ultratorrent/shared';

import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';

/**
 * Operator intent: create, read, change, delete.
 *
 * This service owns the only table in Media Intelligence that is NOT derived.
 * Two consequences it must honour:
 *
 *   - **No reconciliation path may write here.** A sweep rebuilds conclusions;
 *     it must never edit what a person asked for.
 *   - **Deleting a policy removes intent and nothing else.** No media, no
 *     findings, no history. The derived state rebuilds from whatever policies
 *     remain, which is why there is no cascade anywhere near this model.
 *
 * Validation follows the torrent scheduler's discipline: judge what the caller
 * SENT before normalising it. Nulling a stray `scopeId` first would silently
 * accept the contradiction "global, but only for this library" and leave the
 * operator believing it had been honoured.
 */
@Injectable()
export class LifecyclePolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<MediaLifecyclePolicy[]> {
    const rows = await this.prisma.mediaLifecyclePolicy.findMany({
      orderBy: [{ scopeType: 'asc' }, { name: 'asc' }],
    });
    return rows.map((r) => this.toContract(r));
  }

  async byId(id: string): Promise<MediaLifecyclePolicy> {
    const row = await this.prisma.mediaLifecyclePolicy.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Unknown lifecycle policy: ${id}`);
    return this.toContract(row);
  }

  /** Every enabled policy, for the resolver. One read per evaluation pass. */
  async enabled(): Promise<MediaLifecyclePolicy[]> {
    const rows = await this.prisma.mediaLifecyclePolicy.findMany({ where: { enabled: true } });
    return rows.map((r) => this.toContract(r));
  }

  async create(input: PolicyInput, userId?: string, ctx: AuditCtx = {}): Promise<MediaLifecyclePolicy> {
    const data = this.validate(input);
    const created = await this.prisma.mediaLifecyclePolicy.create({
      data: { ...data, createdBy: userId ?? null },
    });

    await this.audit.record({
      userId,
      ...ctx,
      action: 'media_intelligence.lifecycle_policy.created',
      objectType: 'media_lifecycle_policy',
      objectId: created.id,
      // What intent was expressed — never the media it will touch.
      metadata: {
        name: created.name,
        scopeType: created.scopeType,
        enabled: created.enabled,
        dimensions: this.dimensionsSet(created),
      },
    });
    return this.toContract(created);
  }

  async update(
    id: string,
    input: Partial<PolicyInput>,
    userId?: string,
    ctx: AuditCtx = {},
  ): Promise<MediaLifecyclePolicy> {
    const existing = await this.prisma.mediaLifecyclePolicy.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Unknown lifecycle policy: ${id}`);

    // Validate the RESULTING policy, not the patch: switching scope type
    // without clearing the scope id is exactly the broken pair.
    const merged = this.validate({
      name: input.name ?? existing.name,
      description: input.description !== undefined ? input.description : existing.description,
      enabled: input.enabled ?? existing.enabled,
      scopeType: (input.scopeType ?? existing.scopeType) as LifecycleScopeType,
      scopeId: input.scopeType !== undefined ? (input.scopeId ?? null) : existing.scopeId,
      mode: input.mode ?? existing.mode,
      quality: input.quality !== undefined ? input.quality : existing.quality,
      completeness: input.completeness !== undefined ? input.completeness : existing.completeness,
      subtitleLanguages:
        input.subtitleLanguages !== undefined
          ? input.subtitleLanguages
          : (existing.subtitleLanguages as string[] | null),
      acquisition:
        input.acquisition !== undefined
          ? input.acquisition
          : (existing.acquisition as PolicyInput['acquisition']),
    } as PolicyInput);

    const updated = await this.prisma.mediaLifecyclePolicy.update({ where: { id }, data: merged });

    await this.audit.record({
      userId,
      ...ctx,
      // Enabling and disabling are the changes an operator most often needs to
      // find later, so they get their own verb rather than hiding in `updated`.
      action:
        input.enabled !== undefined && input.enabled !== existing.enabled
          ? `media_intelligence.lifecycle_policy.${input.enabled ? 'enabled' : 'disabled'}`
          : 'media_intelligence.lifecycle_policy.updated',
      objectType: 'media_lifecycle_policy',
      objectId: id,
      metadata: {
        name: updated.name,
        scopeType: updated.scopeType,
        enabled: updated.enabled,
        dimensions: this.dimensionsSet(updated),
      },
    });
    return this.toContract(updated);
  }

  /**
   * Remove operator intent.
   *
   * Deletes the policy row and nothing else. Derived desired state and drift
   * rebuild from the remaining policies on the next evaluation, and any
   * recommendation that leaned on this policy is reconciled there rather than
   * being torn out here — this service must not reach into derived tables.
   */
  async remove(id: string, userId?: string, ctx: AuditCtx = {}): Promise<{ id: string }> {
    const existing = await this.prisma.mediaLifecyclePolicy.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Unknown lifecycle policy: ${id}`);

    await this.prisma.mediaLifecyclePolicy.delete({ where: { id } });
    await this.audit.record({
      userId,
      ...ctx,
      action: 'media_intelligence.lifecycle_policy.deleted',
      objectType: 'media_lifecycle_policy',
      objectId: id,
      metadata: { name: existing.name, scopeType: existing.scopeType },
    });
    return { id };
  }

  /* --------------------------------------------------------- validation */

  private validate(input: PolicyInput) {
    const name = (input.name ?? '').trim();
    if (!name) throw new BadRequestException('A policy needs a name.');

    const scopeType = input.scopeType ?? 'global';
    if (!LIFECYCLE_SCOPE_TYPES.includes(scopeType)) {
      throw new BadRequestException(
        `Unknown scope "${scopeType}". Expected one of: ${LIFECYCLE_SCOPE_TYPES.join(', ')}.`,
      );
    }
    /*
     * Judge what was SENT. A global policy carrying a scope id is a
     * contradiction, and quietly discarding the id would leave the operator
     * believing a narrower rule had been saved.
     */
    if (scopeType === 'global' && input.scopeId) {
      throw new BadRequestException('A global policy cannot name a scope id.');
    }
    if (scopeType !== 'global' && !input.scopeId) {
      throw new BadRequestException(`A ${scopeType} policy must name what it applies to.`);
    }

    const mode = input.mode ?? 'recommend_only';
    if (!LIFECYCLE_POLICY_MODES.includes(mode)) {
      // `automatic` lands here on purpose: Phase 5 ships no executor, so a
      // mode implying one is refused rather than silently downgraded.
      throw new BadRequestException(
        `Unknown mode "${mode}". Expected one of: ${LIFECYCLE_POLICY_MODES.join(', ')}.`,
      );
    }

    if (input.quality != null && !LIFECYCLE_QUALITY_INTENTS.includes(input.quality)) {
      throw new BadRequestException(`Unknown quality intent "${input.quality}".`);
    }
    if (input.completeness != null && !LIFECYCLE_COMPLETENESS_INTENTS.includes(input.completeness)) {
      throw new BadRequestException(`Unknown completeness intent "${input.completeness}".`);
    }

    const languages = this.normalizeLanguages(input.subtitleLanguages);

    /*
     * A policy that expresses no intent at all is almost certainly a mistake,
     * and it would sit in the list contributing nothing while looking active.
     */
    const saysSomething =
      input.quality != null ||
      input.completeness != null ||
      languages != null ||
      input.acquisition != null;
    if (!saysSomething) {
      throw new BadRequestException('A policy must set at least one thing to maintain.');
    }

    return {
      name,
      description: input.description?.trim() || null,
      enabled: input.enabled ?? true,
      scopeType,
      scopeId: scopeType === 'global' ? null : (input.scopeId ?? null),
      mode,
      quality: input.quality ?? null,
      completeness: input.completeness ?? null,
      // `undefined` leaves the column NULL ("says nothing"); `[]` is stored as
      // an explicit empty list, which STOPS inheritance. The distinction is
      // the whole three-valued contract, so it must survive this boundary.
      subtitleLanguages: languages === null ? undefined : (languages as object),
      acquisition: (input.acquisition ?? undefined) as object | undefined,
    };
  }

  /**
   * Lowercase, trim, de-duplicate — and preserve the empty list.
   *
   * Returns `null` only when the caller said nothing. An empty array survives
   * as an empty array, because "explicitly no required languages" is a real
   * instruction and folding it into `null` would turn it into "inherit".
   */
  private normalizeLanguages(input: string[] | null | undefined): string[] | null {
    if (input == null) return null;
    return [...new Set(input.map((l) => l.trim().toLowerCase()).filter(Boolean))];
  }

  /** Which dimensions this policy actually speaks to. For the audit trail. */
  private dimensionsSet(row: Record<string, unknown>): string[] {
    return ['quality', 'completeness', 'subtitleLanguages', 'acquisition'].filter(
      (d) => row[d] != null,
    );
  }

  private toContract(row: Record<string, unknown>): MediaLifecyclePolicy {
    return {
      id: row.id as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      enabled: row.enabled as boolean,
      scopeType: row.scopeType as LifecycleScopeType,
      scopeId: (row.scopeId as string | null) ?? null,
      mode: row.mode as MediaLifecyclePolicy['mode'],
      quality: (row.quality as MediaLifecyclePolicy['quality']) ?? null,
      completeness: (row.completeness as MediaLifecyclePolicy['completeness']) ?? null,
      subtitleLanguages: (row.subtitleLanguages as string[] | null) ?? null,
      acquisition: (row.acquisition as MediaLifecyclePolicy['acquisition']) ?? null,
      createdBy: (row.createdBy as string | null) ?? null,
      createdAt: (row.createdAt as Date).toISOString(),
      updatedAt: (row.updatedAt as Date).toISOString(),
    };
  }
}

/** What a caller may set. Mirrors the contract minus the server-owned fields. */
export interface PolicyInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
  scopeType?: LifecycleScopeType;
  scopeId?: string | null;
  mode?: MediaLifecyclePolicy['mode'];
  quality?: MediaLifecyclePolicy['quality'];
  completeness?: MediaLifecyclePolicy['completeness'];
  subtitleLanguages?: string[] | null;
  acquisition?: MediaLifecyclePolicy['acquisition'];
}

/** ip/userAgent, spread straight from `reqAuditContext`. */
type AuditCtx = { ipAddress?: string; userAgent?: string };
