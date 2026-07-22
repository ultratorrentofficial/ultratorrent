import {
  BadRequestException, ForbiddenException, Injectable, Logger,
  NotFoundException, UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { paginate, parsePage } from '../../../common/pagination';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { validatePolicyDocument } from './domain/policy-validator';
import { policyChecksum } from './domain/policy-checksum';
import { describeConditions } from './domain/policy-evaluator';
import { listConditions } from './domain/condition-catalog';
import {
  POLICY_DOCUMENT_SCHEMA_VERSION, POLICY_LIMITS, collectFieldIds,
  type CleanupPolicyDocument,
} from './domain/policy-document';
import type { CreatePolicyDto, PolicyListQueryDto, UpdatePolicyDto } from './dto/policy.dto';

/** A new policy starts inert: report-only, unscoped, and disabled. */
const EMPTY_DOCUMENT: CleanupPolicyDocument = {
  schemaVersion: POLICY_DOCUMENT_SCHEMA_VERSION,
  scope: {},
  conditions: { type: 'all', children: [] },
  exclusions: {
    protected: true, locked: true, activePlayback: true,
    incompleteDownload: true, inFlightOperation: true,
    addedWithinDays: 30, ambiguousIdentity: true, requireMeasuredTechnical: true,
  },
  action: { mode: 'report_only', destination: 'trash' },
};

/**
 * Policies and their immutable versions.
 *
 * The versioning invariant, mirroring the Workflow Builder: a policy has at most
 * one MUTABLE draft; publishing freezes that draft into an immutable published
 * version; the next edit forks a fresh draft from it. A run pins the version it
 * started on, so editing a policy can never change what an in-flight cleanup does.
 */
@Injectable()
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The condition palette + engine limits that drive the policy builder. */
  catalog() {
    return {
      schemaVersion: POLICY_DOCUMENT_SCHEMA_VERSION,
      conditions: listConditions(),
      limits: POLICY_LIMITS,
      operators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'matches'],
    };
  }

  // ── Read ────────────────────────────────────────────────────────────────────
  async list(query: PolicyListQueryDto) {
    const params = parsePage(query.page, query.pageSize, 25, 200);
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (typeof query.enabled === 'boolean') where.enabled = query.enabled;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    return paginate(this.prisma.mediaCleanupPolicy, {
      where,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, name: true, description: true, status: true, enabled: true, mode: true,
        scheduleCron: true, freeSpaceTriggerPercent: true, publishedVersionId: true,
        currentDraftVersionId: true, lastRunAt: true, createdAt: true, updatedAt: true,
      },
    }, params);
  }

  async get(id: string) {
    const policy = await this.prisma.mediaCleanupPolicy.findUnique({ where: { id } });
    if (!policy) throw new NotFoundException('Cleanup policy not found');
    const [draft, published] = await Promise.all([
      policy.currentDraftVersionId
        ? this.prisma.mediaCleanupPolicyVersion.findUnique({ where: { id: policy.currentDraftVersionId } })
        : null,
      policy.publishedVersionId
        ? this.prisma.mediaCleanupPolicyVersion.findUnique({ where: { id: policy.publishedVersionId } })
        : null,
    ]);
    const active = (draft ?? published)?.document as unknown as CleanupPolicyDocument | undefined;
    return {
      policy,
      draftVersion: draft,
      publishedVersion: published,
      summary: active?.conditions ? describeConditions(active.conditions) : null,
    };
  }

  // ── Create / update ─────────────────────────────────────────────────────────
  async create(dto: CreatePolicyDto, user: AuthenticatedUser) {
    const policy = await this.prisma.$transaction(async (tx) => {
      const p = await tx.mediaCleanupPolicy.create({
        data: {
          name: dto.name,
          description: dto.description ?? null,
          status: 'draft',
          enabled: false,
          mode: 'report_only',
          createdById: user.id,
          updatedById: user.id,
        },
      });
      const version = await tx.mediaCleanupPolicyVersion.create({
        data: {
          policyId: p.id,
          versionNumber: 1,
          status: 'draft',
          document: EMPTY_DOCUMENT as unknown as object,
          checksum: policyChecksum(EMPTY_DOCUMENT),
          factKeys: [],
        },
      });
      return tx.mediaCleanupPolicy.update({
        where: { id: p.id },
        data: { currentDraftVersionId: version.id },
      });
    });
    await this.audit.record({
      userId: user.id, action: 'library_cleanup.policy.created',
      objectType: 'media_cleanup_policy', objectId: policy.id, metadata: { name: policy.name },
    });
    return policy;
  }

  async updateMeta(id: string, dto: UpdatePolicyDto, user: AuthenticatedUser) {
    await this.mustExist(id);
    const policy = await this.prisma.mediaCleanupPolicy.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.scheduleCron !== undefined ? { scheduleCron: dto.scheduleCron } : {}),
        ...(dto.freeSpaceTriggerPercent !== undefined ? { freeSpaceTriggerPercent: dto.freeSpaceTriggerPercent } : {}),
        updatedById: user.id,
      },
    });
    await this.audit.record({
      userId: user.id, action: 'library_cleanup.policy.updated',
      objectType: 'media_cleanup_policy', objectId: id,
    });
    return policy;
  }

  /** Save the mutable draft, forking a new one from the published version if needed. */
  async saveDraft(id: string, document: CleanupPolicyDocument, changeNotes: string | undefined, user: AuthenticatedUser) {
    const policy = await this.mustExist(id);
    this.assertDocumentSize(document);

    const validation = validatePolicyDocument(document);
    const versionStatus = validation.valid ? 'ready' : 'validation_failed';
    const draft = await this.ensureDraft(policy, user);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.mediaCleanupPolicyVersion.update({
        where: { id: draft.id },
        data: {
          document: document as unknown as object,
          checksum: policyChecksum(document),
          status: versionStatus,
          factKeys: [...collectFieldIds(document.conditions)],
          changeNotes: changeNotes ?? draft.changeNotes ?? null,
        },
      });
      return tx.mediaCleanupPolicy.update({
        where: { id },
        data: { status: versionStatus, updatedById: user.id },
      });
    });

    await this.audit.record({
      userId: user.id, action: 'library_cleanup.policy.draft_saved',
      objectType: 'media_cleanup_policy', objectId: id,
      result: validation.valid ? 'success' : 'failure',
      metadata: { versionId: draft.id, errors: validation.errors.length },
    });
    return { policy: updated, versionId: draft.id, validation, summary: describeConditions(document.conditions) };
  }

  /** Stateless validation for the editor. */
  validate(document: CleanupPolicyDocument) {
    this.assertDocumentSize(document);
    const validation = validatePolicyDocument(document);
    return {
      validation,
      summary: document?.conditions ? describeConditions(document.conditions) : null,
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  async publish(id: string, changeNotes: string | undefined, user: AuthenticatedUser) {
    const policy = await this.mustExist(id);
    if (!policy.currentDraftVersionId) throw new BadRequestException('No draft changes to publish');

    const draft = await this.prisma.mediaCleanupPolicyVersion.findUnique({
      where: { id: policy.currentDraftVersionId },
    });
    if (!draft) throw new BadRequestException('Draft version missing');

    const document = draft.document as unknown as CleanupPolicyDocument;
    const validation = validatePolicyDocument(document);
    if (!validation.valid) {
      throw new UnprocessableEntityException({ message: 'Policy is invalid', validation });
    }

    const published = await this.prisma.$transaction(async (tx) => {
      await tx.mediaCleanupPolicyVersion.update({
        where: { id: draft.id },
        data: { status: 'published', publishedAt: new Date(), changeNotes: changeNotes ?? draft.changeNotes ?? null },
      });
      return tx.mediaCleanupPolicy.update({
        where: { id },
        // Freeze the draft; the next edit forks a fresh one. Publishing does NOT
        // enable — arming a destructive policy is a separate, deliberate act.
        data: {
          status: 'published',
          publishedVersionId: draft.id,
          currentDraftVersionId: null,
          mode: document.action.mode,
          updatedById: user.id,
        },
      });
    });

    await this.audit.record({
      userId: user.id, action: 'library_cleanup.policy.published',
      objectType: 'media_cleanup_policy', objectId: id,
      metadata: { versionId: draft.id, versionNumber: draft.versionNumber, mode: document.action.mode },
    });
    return { policy: published, versionId: draft.id };
  }

  async setEnabled(id: string, enabled: boolean, user: AuthenticatedUser) {
    const policy = await this.mustExist(id);
    if (enabled && !policy.publishedVersionId) {
      throw new BadRequestException('Publish the policy before enabling it');
    }
    if (policy.enabled === enabled) return policy;

    const updated = await this.prisma.mediaCleanupPolicy.update({
      where: { id },
      data: { enabled, status: enabled ? 'published' : 'disabled', updatedById: user.id },
    });
    await this.audit.record({
      userId: user.id,
      action: enabled ? 'library_cleanup.policy.enabled' : 'library_cleanup.policy.disabled',
      objectType: 'media_cleanup_policy', objectId: id,
      metadata: { mode: policy.mode },
    });
    return updated;
  }

  async archive(id: string, user: AuthenticatedUser) {
    await this.mustExist(id);
    const updated = await this.prisma.mediaCleanupPolicy.update({
      where: { id },
      data: { status: 'archived', enabled: false, archivedAt: new Date(), updatedById: user.id },
    });
    await this.audit.record({
      userId: user.id, action: 'library_cleanup.policy.archived',
      objectType: 'media_cleanup_policy', objectId: id,
    });
    return updated;
  }

  async remove(id: string, user: AuthenticatedUser) {
    await this.mustExist(id);
    const active = await this.prisma.mediaCleanupRun.count({
      where: { policyId: id, status: { in: ['queued', 'running', 'waiting_for_approval'] } },
    });
    if (active > 0) throw new BadRequestException(`Cannot delete a policy with ${active} active run(s)`);
    await this.prisma.mediaCleanupPolicy.delete({ where: { id } });
    await this.audit.record({
      userId: user.id, action: 'library_cleanup.policy.deleted',
      objectType: 'media_cleanup_policy', objectId: id,
    });
    return { deleted: true };
  }

  // ── internals ───────────────────────────────────────────────────────────────
  private async mustExist(id: string) {
    const policy = await this.prisma.mediaCleanupPolicy.findUnique({ where: { id } });
    if (!policy) throw new NotFoundException('Cleanup policy not found');
    if (policy.status === 'archived') throw new ForbiddenException('Policy is archived');
    return policy;
  }

  private async ensureDraft(
    policy: { id: string; currentDraftVersionId: string | null; publishedVersionId: string | null },
    _user: AuthenticatedUser,
  ) {
    if (policy.currentDraftVersionId) {
      const existing = await this.prisma.mediaCleanupPolicyVersion.findUnique({
        where: { id: policy.currentDraftVersionId },
      });
      if (existing && existing.status !== 'published') return existing;
    }
    const max = await this.prisma.mediaCleanupPolicyVersion.aggregate({
      where: { policyId: policy.id }, _max: { versionNumber: true },
    });
    const base = policy.publishedVersionId
      ? await this.prisma.mediaCleanupPolicyVersion.findUnique({ where: { id: policy.publishedVersionId } })
      : null;
    const draft = await this.prisma.mediaCleanupPolicyVersion.create({
      data: {
        policyId: policy.id,
        versionNumber: (max._max.versionNumber ?? 0) + 1,
        status: 'draft',
        document: (base?.document ?? EMPTY_DOCUMENT) as unknown as object,
        checksum: base?.checksum ?? policyChecksum(EMPTY_DOCUMENT),
        factKeys: base?.factKeys ?? [],
      },
    });
    await this.prisma.mediaCleanupPolicy.update({
      where: { id: policy.id }, data: { currentDraftVersionId: draft.id },
    });
    return draft;
  }

  private assertDocumentSize(doc: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(doc ?? {}), 'utf8');
    if (bytes > POLICY_LIMITS.maxDocumentBytes) {
      throw new BadRequestException(`Policy document exceeds the ${POLICY_LIMITS.maxDocumentBytes}-byte limit`);
    }
  }
}
