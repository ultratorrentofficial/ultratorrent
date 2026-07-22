import { classifyResolution, resolutionOrdinal } from './resolution-class';
import { isNeverWatched, isTrustworthy, type PlaybackAggregateFacts } from './playback-aggregate';
import type { EvaluationFacts } from './policy-evaluator';
import type { ExclusionFacts } from './exclusion-rules';

/**
 * Fact assembly — raw rows in, the facts the evaluator and the exclusion pass read
 * out. Pure, so the mapping is tested directly rather than through a database.
 *
 * The rule running through all of it: a fact we could not establish is `undefined`,
 * never a substituted default. The evaluator treats an absent fact as UNMEASURED
 * and the exclusion pass refuses the candidate. Filling a blank with 0, false or
 * "unknown" here would quietly convert "we don't know" into "it qualifies", which
 * is precisely how a cleanup deletes something it should not have.
 */

export interface RawMediaFile {
  id: string;
  path: string;
  size: bigint | number;
  width?: number | null;
  height?: number | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  audioChannels?: number | null;
  bitrateKbps?: number | null;
  frameRate?: number | null;
  container?: string | null;
  durationSec?: number | null;
  videoBitDepth?: number | null;
  chromaSubsampling?: string | null;
  hdrFormat?: string | null;
  hdr?: string | null;
  techSource?: string | null;
  probedAt?: Date | null;
  probeError?: string | null;
  modifiedAt?: Date | null;
}

export interface RawMediaItem {
  id: string;
  libraryId: string;
  mediaType?: string | null;
  year?: number | null;
  matchStatus?: string | null;
  confidence?: number | null;
  locked?: boolean | null;
  createdAt?: Date | null;
  duplicateGroupId?: string | null;
  externalIds?: Array<{ provider: string; externalId: string }>;
  metadata?: {
    genres?: unknown;
    tags?: unknown;
    certification?: string | null;
    language?: string | null;
    runtimeMinutes?: number | null;
    rating?: number | null;
    releaseDate?: Date | null;
  } | null;
}

export interface RawContext {
  libraryKind?: string | null;
  /** null when this item has no aggregate row at all. */
  playback: PlaybackAggregateFacts | null;
  playbackComputedAt: Date | null;
  onWatchlist: boolean;
  inCollection: boolean;
  collectionIds: string[];
  activePlayback: boolean;
  hasActiveJob: boolean;
  incompleteDownload: boolean;
  inFlightOperation: boolean;
  pendingDuplicateResolution: boolean;
  torrentActive?: boolean;
  torrentSeeding?: boolean;
  torrentRatio?: number | null;
  libraryFreePercent?: number | null;
  totalTitleSizeBytes?: number | null;
  isLastSurvivingCopy: boolean;
  hasVerifiedReplacement: boolean;
  betterReplacementExists: boolean;
  isProtected: boolean;
  hasLegalHold: boolean;
  withinHardRoots: boolean;
  isSystemPath: boolean;
  isLibraryRoot: boolean;
  fileExists: boolean;
  now?: Date;
}

const daysBetween = (from: Date | null | undefined, to: Date): number | undefined =>
  from ? Math.floor((to.getTime() - from.getTime()) / 86_400_000) : undefined;

/** A probed row owns its technical facts; anything else is a filename guess. */
export function isProbeMeasured(file: RawMediaFile): boolean {
  return file.techSource === 'probe' && file.probedAt != null;
}

export function assembleEvaluationFacts(
  file: RawMediaFile,
  item: RawMediaItem,
  ctx: RawContext,
): EvaluationFacts {
  const now = ctx.now ?? new Date();
  const measured = isProbeMeasured(file);
  const cls = measured ? classifyResolution(file.width, file.height) : 'unknown';

  const meta = item.metadata ?? {};
  const asArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.map(String) : undefined;

  return {
    metadata: {
      mediaKind: item.mediaType ?? undefined,
      releaseYear: item.year ?? undefined,
      releaseDate: meta.releaseDate ?? undefined,
      genres: asArray(meta.genres),
      tags: asArray(meta.tags),
      certification: meta.certification ?? undefined,
      language: meta.language ?? undefined,
      runtimeMinutes: meta.runtimeMinutes ?? undefined,
      rating: meta.rating ?? undefined,
      matchStatus: item.matchStatus ?? undefined,
      hasExternalId: (item.externalIds?.length ?? 0) > 0,
      metadataComplete: item.metadata != null,
      inCollection: ctx.inCollection,
      onWatchlist: ctx.onWatchlist,
    },
    // No aggregate at all → every playback fact stays undefined, i.e. UNMEASURED.
    // Substituting zero here is the difference between "nobody watched it" and
    // "we never looked", and only one of those is grounds to delete.
    playback: ctx.playback
      ? {
          neverWatched: isNeverWatched(ctx.playback),
          completedPlayCount: ctx.playback.completedPlayCount,
          startedPlayCount: ctx.playback.startedPlayCount,
          uniqueViewerCount: ctx.playback.uniqueViewerCount,
          lastPlayedAt: ctx.playback.lastPlayedAt ?? undefined,
          daysSinceLastPlay: daysBetween(ctx.playback.lastPlayedAt, now),
          maximumProgressPercent: ctx.playback.maximumProgressPercent,
          averageProgressPercent: ctx.playback.averageProgressPercent,
          totalPlaybackSeconds: ctx.playback.totalPlaybackSeconds,
          watchedByNoUsers: ctx.playback.uniqueViewerCount === 0,
        }
      : {},
    technical: {
      techSource: measured ? 'probe' : file.techSource === 'filename' ? 'filename' : 'unknown',
      // Ordinal is what an ordered comparison reads; unmeasured stays absent.
      resolutionOrdinal: measured ? (resolutionOrdinal(cls) ?? undefined) : undefined,
      resolutionClass: measured ? cls : undefined,
      width: file.width ?? undefined,
      height: file.height ?? undefined,
      videoCodec: file.videoCodec ?? undefined,
      videoBitDepth: file.videoBitDepth ?? undefined,
      chromaSubsampling: file.chromaSubsampling ?? undefined,
      hdrFormat: file.hdrFormat ?? undefined,
      isHdr: measured ? Boolean(file.hdrFormat ?? file.hdr) : undefined,
      audioCodec: file.audioCodec ?? undefined,
      audioChannels: file.audioChannels ?? undefined,
      bitrateKbps: file.bitrateKbps ?? undefined,
      frameRate: file.frameRate ?? undefined,
      container: file.container ?? undefined,
      durationSec: file.durationSec ?? undefined,
      probeFailed: file.probeError != null,
    },
    storage: {
      fileSizeBytes: Number(file.size),
      fileModifiedAt: file.modifiedAt ?? undefined,
      fileAgeDays: daysBetween(file.modifiedAt, now),
      addedAt: item.createdAt ?? undefined,
      addedAgeDays: daysBetween(item.createdAt, now),
      totalTitleSizeBytes: ctx.totalTitleSizeBytes ?? undefined,
      libraryFreePercent: ctx.libraryFreePercent ?? undefined,
      isDuplicate: item.duplicateGroupId != null,
      betterReplacementExists: ctx.betterReplacementExists,
      torrentActive: ctx.torrentActive,
      torrentSeeding: ctx.torrentSeeding,
      torrentRatio: ctx.torrentRatio ?? undefined,
    },
    safety: {
      libraryId: item.libraryId,
      libraryKind: ctx.libraryKind ?? undefined,
      path: file.path,
      isLocked: Boolean(item.locked),
      isProtected: ctx.isProtected,
      hasActiveJob: ctx.hasActiveJob,
      activePlayback: ctx.activePlayback,
      ambiguousIdentity: isAmbiguous(item),
      pendingDuplicateResolution: ctx.pendingDuplicateResolution,
    },
  };
}

/**
 * Identity is ambiguous when nothing pins it down. There is no `ambiguous` column,
 * so this is derived: an unmatched item, or a matched one with low confidence and
 * no external id, cannot be trusted by a policy that reasons about identity.
 */
export function isAmbiguous(item: RawMediaItem): boolean {
  if (item.matchStatus === 'manual') return false; // a human asserted it
  if (item.matchStatus === 'unmatched') return true;
  const hasId = (item.externalIds?.length ?? 0) > 0;
  if (hasId) return false;
  return (item.confidence ?? 0) < 0.8;
}

export function assembleExclusionFacts(
  file: RawMediaFile,
  item: RawMediaItem,
  ctx: RawContext,
  policyUses: { measured: boolean; playback: boolean },
): ExclusionFacts {
  return {
    isProtected: ctx.isProtected,
    hasLegalHold: ctx.hasLegalHold,
    isLocked: Boolean(item.locked),
    withinHardRoots: ctx.withinHardRoots,
    isSystemPath: ctx.isSystemPath,
    isLibraryRoot: ctx.isLibraryRoot,
    fileExists: ctx.fileExists,
    activePlayback: ctx.activePlayback,
    incompleteDownload: ctx.incompleteDownload,
    inFlightOperation: ctx.inFlightOperation,
    hasActiveJob: ctx.hasActiveJob,
    pendingDuplicateResolution: ctx.pendingDuplicateResolution,
    addedAt: item.createdAt ?? null,
    ambiguousIdentity: isAmbiguous(item),
    technicalMeasured: isProbeMeasured(file),
    policyUsesMeasuredConditions: policyUses.measured,
    // No aggregate row is NOT a trustworthy zero — it is an absence.
    playbackTrustworthy: ctx.playback
      ? isTrustworthy(ctx.playback, { zeroIsMeaningful: true })
      : false,
    policyUsesPlaybackConditions: policyUses.playback,
    playbackComputedAt: ctx.playbackComputedAt,
    maximumProgressPercent: ctx.playback?.maximumProgressPercent ?? null,
    isLastSurvivingCopy: ctx.isLastSurvivingCopy,
    hasVerifiedReplacement: ctx.hasVerifiedReplacement,
  };
}
