/**
 * The cleanup condition catalogue.
 *
 * One registry, read by the validator, the evaluator and the UI palette, so a
 * policy can never reference a condition the engine cannot evaluate — the same
 * discipline the Workflow node registry uses.
 *
 * `factPath` is where the condition reads from the evaluation facts object.
 * `requiresMeasuredData` is the load-bearing flag: when true, the fact must come
 * from a probe, and a candidate whose value is filename-derived or absent is
 * EXCLUDED (`excluded_unmeasured`) rather than matched or unmatched. A release name
 * saying `10bit` is a hint, never grounds to delete.
 */

export type ConditionDataType = 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'string[]';

export type ConditionCategory = 'metadata' | 'playback' | 'technical' | 'storage' | 'safety';

/** How dangerous it is to act on this condition alone. Surfaced in the UI. */
export type SafetyLevel = 'informational' | 'normal' | 'elevated';

export interface CleanupConditionDefinition {
  id: string;
  labelKey: string;
  descriptionKey: string;
  category: ConditionCategory;
  dataType: ConditionDataType;
  operators: string[];
  /** Where this reads from the facts object. */
  factPath: string;
  /** Destructive use demands probe-measured data. */
  requiresMeasuredData?: boolean;
  /** Restricts the condition to certain library kinds. */
  supportedMediaKinds?: string[];
  safetyLevel?: SafetyLevel;
  /** Allowed values for enum conditions. */
  enumValues?: readonly string[];
}

const EQ = ['eq', 'neq'];
const ORD = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'];
const TEXT = ['eq', 'neq', 'contains', 'matches'];

const def = (d: CleanupConditionDefinition): CleanupConditionDefinition => d;

export const CLEANUP_CONDITIONS: CleanupConditionDefinition[] = [
  // ── Metadata ──────────────────────────────────────────────────────────────
  def({ id: 'metadata.mediaKind', labelKey: 'cleanup.cond.mediaKind', descriptionKey: 'cleanup.cond.mediaKind.desc', category: 'metadata', dataType: 'enum', operators: EQ, factPath: 'metadata.mediaKind', enumValues: ['movie', 'tv', 'anime', 'music_video', 'documentary', 'other_video'] }),
  def({ id: 'metadata.releaseYear', labelKey: 'cleanup.cond.releaseYear', descriptionKey: 'cleanup.cond.releaseYear.desc', category: 'metadata', dataType: 'number', operators: ORD, factPath: 'metadata.releaseYear' }),
  def({ id: 'metadata.releaseDate', labelKey: 'cleanup.cond.releaseDate', descriptionKey: 'cleanup.cond.releaseDate.desc', category: 'metadata', dataType: 'date', operators: ORD, factPath: 'metadata.releaseDate' }),
  def({ id: 'metadata.genre', labelKey: 'cleanup.cond.genre', descriptionKey: 'cleanup.cond.genre.desc', category: 'metadata', dataType: 'string[]', operators: ['contains'], factPath: 'metadata.genres' }),
  def({ id: 'metadata.certification', labelKey: 'cleanup.cond.certification', descriptionKey: 'cleanup.cond.certification.desc', category: 'metadata', dataType: 'string', operators: TEXT, factPath: 'metadata.certification' }),
  def({ id: 'metadata.language', labelKey: 'cleanup.cond.language', descriptionKey: 'cleanup.cond.language.desc', category: 'metadata', dataType: 'string', operators: TEXT, factPath: 'metadata.language' }),
  def({ id: 'metadata.runtimeMinutes', labelKey: 'cleanup.cond.runtime', descriptionKey: 'cleanup.cond.runtime.desc', category: 'metadata', dataType: 'number', operators: ORD, factPath: 'metadata.runtimeMinutes' }),
  def({ id: 'metadata.rating', labelKey: 'cleanup.cond.rating', descriptionKey: 'cleanup.cond.rating.desc', category: 'metadata', dataType: 'number', operators: ORD, factPath: 'metadata.rating' }),
  def({ id: 'metadata.matchStatus', labelKey: 'cleanup.cond.matchStatus', descriptionKey: 'cleanup.cond.matchStatus.desc', category: 'metadata', dataType: 'enum', operators: EQ, factPath: 'metadata.matchStatus', enumValues: ['unmatched', 'matched', 'manual'] }),
  def({ id: 'metadata.hasExternalId', labelKey: 'cleanup.cond.hasExternalId', descriptionKey: 'cleanup.cond.hasExternalId.desc', category: 'metadata', dataType: 'boolean', operators: EQ, factPath: 'metadata.hasExternalId' }),
  def({ id: 'metadata.metadataComplete', labelKey: 'cleanup.cond.metadataComplete', descriptionKey: 'cleanup.cond.metadataComplete.desc', category: 'metadata', dataType: 'boolean', operators: EQ, factPath: 'metadata.metadataComplete' }),
  def({ id: 'metadata.inCollection', labelKey: 'cleanup.cond.inCollection', descriptionKey: 'cleanup.cond.inCollection.desc', category: 'metadata', dataType: 'boolean', operators: EQ, factPath: 'metadata.inCollection' }),
  def({ id: 'metadata.onWatchlist', labelKey: 'cleanup.cond.onWatchlist', descriptionKey: 'cleanup.cond.onWatchlist.desc', category: 'metadata', dataType: 'boolean', operators: EQ, factPath: 'metadata.onWatchlist' }),
  def({ id: 'metadata.tag', labelKey: 'cleanup.cond.tag', descriptionKey: 'cleanup.cond.tag.desc', category: 'metadata', dataType: 'string[]', operators: ['contains'], factPath: 'metadata.tags' }),

  // ── Playback & usage ──────────────────────────────────────────────────────
  def({ id: 'playback.neverWatched', labelKey: 'cleanup.cond.neverWatched', descriptionKey: 'cleanup.cond.neverWatched.desc', category: 'playback', dataType: 'boolean', operators: EQ, factPath: 'playback.neverWatched', safetyLevel: 'elevated' }),
  def({ id: 'playback.completedPlayCount', labelKey: 'cleanup.cond.completedPlays', descriptionKey: 'cleanup.cond.completedPlays.desc', category: 'playback', dataType: 'number', operators: ORD, factPath: 'playback.completedPlayCount', safetyLevel: 'elevated' }),
  def({ id: 'playback.startedPlayCount', labelKey: 'cleanup.cond.startedPlays', descriptionKey: 'cleanup.cond.startedPlays.desc', category: 'playback', dataType: 'number', operators: ORD, factPath: 'playback.startedPlayCount' }),
  def({ id: 'playback.uniqueViewerCount', labelKey: 'cleanup.cond.uniqueViewers', descriptionKey: 'cleanup.cond.uniqueViewers.desc', category: 'playback', dataType: 'number', operators: ORD, factPath: 'playback.uniqueViewerCount' }),
  def({ id: 'playback.lastPlayedAt', labelKey: 'cleanup.cond.lastPlayedAt', descriptionKey: 'cleanup.cond.lastPlayedAt.desc', category: 'playback', dataType: 'date', operators: ORD, factPath: 'playback.lastPlayedAt' }),
  def({ id: 'playback.daysSinceLastPlay', labelKey: 'cleanup.cond.daysSinceLastPlay', descriptionKey: 'cleanup.cond.daysSinceLastPlay.desc', category: 'playback', dataType: 'number', operators: ORD, factPath: 'playback.daysSinceLastPlay' }),
  def({ id: 'playback.maximumProgressPercent', labelKey: 'cleanup.cond.maxProgress', descriptionKey: 'cleanup.cond.maxProgress.desc', category: 'playback', dataType: 'number', operators: ORD, factPath: 'playback.maximumProgressPercent' }),
  def({ id: 'playback.averageProgressPercent', labelKey: 'cleanup.cond.avgProgress', descriptionKey: 'cleanup.cond.avgProgress.desc', category: 'playback', dataType: 'number', operators: ORD, factPath: 'playback.averageProgressPercent' }),
  def({ id: 'playback.totalPlaybackSeconds', labelKey: 'cleanup.cond.totalSeconds', descriptionKey: 'cleanup.cond.totalSeconds.desc', category: 'playback', dataType: 'number', operators: ORD, factPath: 'playback.totalPlaybackSeconds' }),
  def({ id: 'playback.watchedByNoUsers', labelKey: 'cleanup.cond.watchedByNoUsers', descriptionKey: 'cleanup.cond.watchedByNoUsers.desc', category: 'playback', dataType: 'boolean', operators: EQ, factPath: 'playback.watchedByNoUsers' }),
  def({ id: 'playback.watchedByAllUsers', labelKey: 'cleanup.cond.watchedByAllUsers', descriptionKey: 'cleanup.cond.watchedByAllUsers.desc', category: 'playback', dataType: 'boolean', operators: EQ, factPath: 'playback.watchedByAllUsers' }),
  def({ id: 'playback.traktWatched', labelKey: 'cleanup.cond.traktWatched', descriptionKey: 'cleanup.cond.traktWatched.desc', category: 'playback', dataType: 'boolean', operators: EQ, factPath: 'playback.traktWatched' }),

  // ── Technical (measured) ──────────────────────────────────────────────────
  def({ id: 'technical.resolutionClass', labelKey: 'cleanup.cond.resolutionClass', descriptionKey: 'cleanup.cond.resolutionClass.desc', category: 'technical', dataType: 'enum', operators: ORD, factPath: 'technical.resolutionOrdinal', requiresMeasuredData: true, enumValues: ['sd', '480p', '576p', '720p', '1080p', '1440p', '2160p', '4320p'] }),
  def({ id: 'technical.width', labelKey: 'cleanup.cond.width', descriptionKey: 'cleanup.cond.width.desc', category: 'technical', dataType: 'number', operators: ORD, factPath: 'technical.width', requiresMeasuredData: true }),
  def({ id: 'technical.height', labelKey: 'cleanup.cond.height', descriptionKey: 'cleanup.cond.height.desc', category: 'technical', dataType: 'number', operators: ORD, factPath: 'technical.height', requiresMeasuredData: true }),
  def({ id: 'technical.videoCodec', labelKey: 'cleanup.cond.videoCodec', descriptionKey: 'cleanup.cond.videoCodec.desc', category: 'technical', dataType: 'string', operators: TEXT, factPath: 'technical.videoCodec', requiresMeasuredData: true }),
  def({ id: 'technical.videoBitDepth', labelKey: 'cleanup.cond.videoBitDepth', descriptionKey: 'cleanup.cond.videoBitDepth.desc', category: 'technical', dataType: 'number', operators: ORD, factPath: 'technical.videoBitDepth', requiresMeasuredData: true }),
  def({ id: 'technical.chromaSubsampling', labelKey: 'cleanup.cond.chroma', descriptionKey: 'cleanup.cond.chroma.desc', category: 'technical', dataType: 'string', operators: TEXT, factPath: 'technical.chromaSubsampling', requiresMeasuredData: true }),
  def({ id: 'technical.hdrFormat', labelKey: 'cleanup.cond.hdrFormat', descriptionKey: 'cleanup.cond.hdrFormat.desc', category: 'technical', dataType: 'string', operators: TEXT, factPath: 'technical.hdrFormat', requiresMeasuredData: true }),
  def({ id: 'technical.isHdr', labelKey: 'cleanup.cond.isHdr', descriptionKey: 'cleanup.cond.isHdr.desc', category: 'technical', dataType: 'boolean', operators: EQ, factPath: 'technical.isHdr', requiresMeasuredData: true }),
  def({ id: 'technical.audioCodec', labelKey: 'cleanup.cond.audioCodec', descriptionKey: 'cleanup.cond.audioCodec.desc', category: 'technical', dataType: 'string', operators: TEXT, factPath: 'technical.audioCodec', requiresMeasuredData: true }),
  def({ id: 'technical.audioChannels', labelKey: 'cleanup.cond.audioChannels', descriptionKey: 'cleanup.cond.audioChannels.desc', category: 'technical', dataType: 'number', operators: ORD, factPath: 'technical.audioChannels', requiresMeasuredData: true }),
  def({ id: 'technical.bitrateKbps', labelKey: 'cleanup.cond.bitrate', descriptionKey: 'cleanup.cond.bitrate.desc', category: 'technical', dataType: 'number', operators: ORD, factPath: 'technical.bitrateKbps', requiresMeasuredData: true }),
  def({ id: 'technical.frameRate', labelKey: 'cleanup.cond.frameRate', descriptionKey: 'cleanup.cond.frameRate.desc', category: 'technical', dataType: 'number', operators: ORD, factPath: 'technical.frameRate', requiresMeasuredData: true }),
  def({ id: 'technical.container', labelKey: 'cleanup.cond.container', descriptionKey: 'cleanup.cond.container.desc', category: 'technical', dataType: 'string', operators: TEXT, factPath: 'technical.container' }),
  def({ id: 'technical.durationSec', labelKey: 'cleanup.cond.duration', descriptionKey: 'cleanup.cond.duration.desc', category: 'technical', dataType: 'number', operators: ORD, factPath: 'technical.durationSec', requiresMeasuredData: true }),
  def({ id: 'technical.techSource', labelKey: 'cleanup.cond.techSource', descriptionKey: 'cleanup.cond.techSource.desc', category: 'technical', dataType: 'enum', operators: EQ, factPath: 'technical.techSource', enumValues: ['probe', 'filename', 'unknown'] }),
  def({ id: 'technical.probeFailed', labelKey: 'cleanup.cond.probeFailed', descriptionKey: 'cleanup.cond.probeFailed.desc', category: 'technical', dataType: 'boolean', operators: EQ, factPath: 'technical.probeFailed' }),

  // ── Storage & lifecycle ───────────────────────────────────────────────────
  def({ id: 'storage.fileSizeBytes', labelKey: 'cleanup.cond.fileSize', descriptionKey: 'cleanup.cond.fileSize.desc', category: 'storage', dataType: 'number', operators: ORD, factPath: 'storage.fileSizeBytes' }),
  def({ id: 'storage.fileModifiedAt', labelKey: 'cleanup.cond.fileModifiedAt', descriptionKey: 'cleanup.cond.fileModifiedAt.desc', category: 'storage', dataType: 'date', operators: ORD, factPath: 'storage.fileModifiedAt' }),
  def({ id: 'storage.fileAgeDays', labelKey: 'cleanup.cond.fileAgeDays', descriptionKey: 'cleanup.cond.fileAgeDays.desc', category: 'storage', dataType: 'number', operators: ORD, factPath: 'storage.fileAgeDays' }),
  def({ id: 'storage.addedAt', labelKey: 'cleanup.cond.addedAt', descriptionKey: 'cleanup.cond.addedAt.desc', category: 'storage', dataType: 'date', operators: ORD, factPath: 'storage.addedAt' }),
  def({ id: 'storage.addedAgeDays', labelKey: 'cleanup.cond.addedAgeDays', descriptionKey: 'cleanup.cond.addedAgeDays.desc', category: 'storage', dataType: 'number', operators: ORD, factPath: 'storage.addedAgeDays' }),
  def({ id: 'storage.totalTitleSizeBytes', labelKey: 'cleanup.cond.totalTitleSize', descriptionKey: 'cleanup.cond.totalTitleSize.desc', category: 'storage', dataType: 'number', operators: ORD, factPath: 'storage.totalTitleSizeBytes' }),
  def({ id: 'storage.libraryFreePercent', labelKey: 'cleanup.cond.libraryFreePercent', descriptionKey: 'cleanup.cond.libraryFreePercent.desc', category: 'storage', dataType: 'number', operators: ORD, factPath: 'storage.libraryFreePercent' }),
  def({ id: 'storage.isDuplicate', labelKey: 'cleanup.cond.isDuplicate', descriptionKey: 'cleanup.cond.isDuplicate.desc', category: 'storage', dataType: 'boolean', operators: EQ, factPath: 'storage.isDuplicate' }),
  def({ id: 'storage.betterReplacementExists', labelKey: 'cleanup.cond.betterReplacement', descriptionKey: 'cleanup.cond.betterReplacement.desc', category: 'storage', dataType: 'boolean', operators: EQ, factPath: 'storage.betterReplacementExists', safetyLevel: 'elevated' }),
  def({ id: 'storage.torrentActive', labelKey: 'cleanup.cond.torrentActive', descriptionKey: 'cleanup.cond.torrentActive.desc', category: 'storage', dataType: 'boolean', operators: EQ, factPath: 'storage.torrentActive' }),
  def({ id: 'storage.torrentSeeding', labelKey: 'cleanup.cond.torrentSeeding', descriptionKey: 'cleanup.cond.torrentSeeding.desc', category: 'storage', dataType: 'boolean', operators: EQ, factPath: 'storage.torrentSeeding' }),
  def({ id: 'storage.torrentRatio', labelKey: 'cleanup.cond.torrentRatio', descriptionKey: 'cleanup.cond.torrentRatio.desc', category: 'storage', dataType: 'number', operators: ORD, factPath: 'storage.torrentRatio' }),

  // ── Safety & state ────────────────────────────────────────────────────────
  def({ id: 'safety.libraryId', labelKey: 'cleanup.cond.libraryId', descriptionKey: 'cleanup.cond.libraryId.desc', category: 'safety', dataType: 'string', operators: EQ, factPath: 'safety.libraryId' }),
  def({ id: 'safety.libraryKind', labelKey: 'cleanup.cond.libraryKind', descriptionKey: 'cleanup.cond.libraryKind.desc', category: 'safety', dataType: 'enum', operators: EQ, factPath: 'safety.libraryKind', enumValues: ['tv', 'anime', 'movie', 'music', 'audiobook', 'general'] }),
  def({ id: 'safety.pathPrefix', labelKey: 'cleanup.cond.pathPrefix', descriptionKey: 'cleanup.cond.pathPrefix.desc', category: 'safety', dataType: 'string', operators: ['contains', 'matches'], factPath: 'safety.path' }),
  def({ id: 'safety.isLocked', labelKey: 'cleanup.cond.isLocked', descriptionKey: 'cleanup.cond.isLocked.desc', category: 'safety', dataType: 'boolean', operators: EQ, factPath: 'safety.isLocked' }),
  def({ id: 'safety.isProtected', labelKey: 'cleanup.cond.isProtected', descriptionKey: 'cleanup.cond.isProtected.desc', category: 'safety', dataType: 'boolean', operators: EQ, factPath: 'safety.isProtected' }),
  def({ id: 'safety.hasActiveJob', labelKey: 'cleanup.cond.hasActiveJob', descriptionKey: 'cleanup.cond.hasActiveJob.desc', category: 'safety', dataType: 'boolean', operators: EQ, factPath: 'safety.hasActiveJob' }),
  def({ id: 'safety.activePlayback', labelKey: 'cleanup.cond.activePlayback', descriptionKey: 'cleanup.cond.activePlayback.desc', category: 'safety', dataType: 'boolean', operators: EQ, factPath: 'safety.activePlayback' }),
  def({ id: 'safety.ambiguousIdentity', labelKey: 'cleanup.cond.ambiguousIdentity', descriptionKey: 'cleanup.cond.ambiguousIdentity.desc', category: 'safety', dataType: 'boolean', operators: EQ, factPath: 'safety.ambiguousIdentity' }),
  def({ id: 'safety.pendingDuplicateResolution', labelKey: 'cleanup.cond.pendingDuplicate', descriptionKey: 'cleanup.cond.pendingDuplicate.desc', category: 'safety', dataType: 'boolean', operators: EQ, factPath: 'safety.pendingDuplicateResolution' }),
];

const BY_ID = new Map(CLEANUP_CONDITIONS.map((c) => [c.id, c]));

export function getCondition(id: string): CleanupConditionDefinition | undefined {
  return BY_ID.get(id);
}

export function listConditions(category?: ConditionCategory): CleanupConditionDefinition[] {
  return category ? CLEANUP_CONDITIONS.filter((c) => c.category === category) : CLEANUP_CONDITIONS;
}

/** Conditions whose destructive use requires probe-measured data. */
export function measuredOnlyConditionIds(): string[] {
  return CLEANUP_CONDITIONS.filter((c) => c.requiresMeasuredData).map((c) => c.id);
}
