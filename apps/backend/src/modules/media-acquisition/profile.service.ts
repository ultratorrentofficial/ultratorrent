import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface ProfileInput {
  name: string;
  description?: string;
  mediaType: string;
  minimumScore?: number;
  approvalScore?: number;
  minimumResolution?: string;
  preferredResolution?: string;
  preferredSource?: string;
  preferredCodec?: string;
  preferredAudio?: string;
  preferredHdr?: string;
  preferredLanguages?: string[];
  requiredTerms?: string[];
  excludedTerms?: string[];
  preferredGroups?: string[];
  /**
   * Release size bounds, in bytes. Null/absent = unbounded on that side.
   *
   * These become the `sizeRules` of the preference tier this profile is turned into.
   * A profile tier takes precedence over the global default candidates, so without a
   * cap here the ONLY size limit in the system (the defaults' `≤1 GB`) is simply never
   * consulted once a profile matches — which is how a 1.63 GB episode landed in a
   * library whose every other episode was under 1 GB.
   */
  minSizeBytes?: number | null;
  maxSizeBytes?: number | null;
  qualityRules?: Record<string, unknown>;
  duplicateRules?: Record<string, unknown>;
  storageRules?: Record<string, unknown>;
  automationRules?: Record<string, unknown>;
  enabled?: boolean;
}

/** Acquisition profile CRUD: quality preferences + approval/upgrade/storage rules. */
@Injectable()
export class AcquisitionProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(mediaType?: string) {
    return this.prisma.mediaAcquisitionProfile.findMany({ where: { mediaType }, orderBy: { createdAt: 'desc' } });
  }

  async get(id: string) {
    const p = await this.prisma.mediaAcquisitionProfile.findUnique({ where: { id } });
    if (!p) throw new NotFoundException(`Unknown acquisition profile: ${id}`);
    return p;
  }

  async create(input: ProfileInput, userId?: string) {
    const p = await this.prisma.mediaAcquisitionProfile.create({ data: this.toData(input, true) });
    await this.audit.record({ userId, action: 'media_acquisition.profile.created', objectType: 'media_acquisition_profile', objectId: p.id });
    return p;
  }

  async update(id: string, input: Partial<ProfileInput>, userId?: string) {
    await this.get(id);
    const p = await this.prisma.mediaAcquisitionProfile.update({ where: { id }, data: this.toData(input, false) });
    await this.audit.record({ userId, action: 'media_acquisition.profile.updated', objectType: 'media_acquisition_profile', objectId: id });
    return p;
  }

  async remove(id: string, userId?: string) {
    await this.get(id);
    await this.prisma.mediaAcquisitionProfile.delete({ where: { id } });
    await this.audit.record({ userId, action: 'media_acquisition.profile.deleted', objectType: 'media_acquisition_profile', objectId: id });
    return { ok: true as const };
  }

  private toData(input: Partial<ProfileInput>, create: boolean): any {
    const json = (v: unknown) => (v === undefined ? undefined : (v as object));
    const bytes = (v: number | null | undefined) =>
      v === undefined ? undefined : v === null ? null : BigInt(Math.round(v));
    return {
      name: input.name ?? (create ? 'Untitled' : undefined),
      description: input.description === undefined ? undefined : input.description,
      mediaType: input.mediaType ?? (create ? 'any' : undefined),
      minimumScore: input.minimumScore === undefined ? (create ? 0 : undefined) : input.minimumScore,
      approvalScore: input.approvalScore === undefined ? (create ? 0 : undefined) : input.approvalScore,
      minimumResolution: input.minimumResolution === undefined ? undefined : input.minimumResolution,
      preferredResolution: input.preferredResolution === undefined ? undefined : input.preferredResolution,
      preferredSource: input.preferredSource === undefined ? undefined : input.preferredSource,
      preferredCodec: input.preferredCodec === undefined ? undefined : input.preferredCodec,
      preferredAudio: input.preferredAudio === undefined ? undefined : input.preferredAudio,
      preferredHdr: input.preferredHdr === undefined ? undefined : input.preferredHdr,
      preferredLanguages: json(input.preferredLanguages),
      requiredTerms: json(input.requiredTerms),
      excludedTerms: json(input.excludedTerms),
      preferredGroups: json(input.preferredGroups),
      // BigInt column (a 1080p movie exceeds the Int32 ceiling). An explicit null
      // clears the bound; undefined leaves it untouched on an update.
      minSizeBytes: bytes(input.minSizeBytes),
      maxSizeBytes: bytes(input.maxSizeBytes),
      qualityRules: json(input.qualityRules),
      duplicateRules: json(input.duplicateRules),
      storageRules: json(input.storageRules),
      automationRules: json(input.automationRules),
      enabled: input.enabled === undefined ? (create ? true : undefined) : input.enabled,
    };
  }
}
