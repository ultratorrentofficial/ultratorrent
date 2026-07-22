import { POLICY_DOCUMENT_SCHEMA_VERSION, type CleanupPolicyDocument } from './policy-document';

/**
 * Starter policy templates.
 *
 * They ship as CODE, not as seeded rows. Seeding live policy records — even
 * disabled ones — puts destructive-shaped objects in every install's database that
 * an operator never asked for and might enable without reading. A template creates
 * nothing until someone deliberately instantiates it, and what it then creates is
 * an ordinary DRAFT policy they own, still disabled, still requiring publish and a
 * separate enable.
 *
 * Every template is asserted valid by the test suite, so a template that would be
 * refused at publish cannot ship.
 */

export interface CleanupPolicyTemplate {
  key: string;
  nameKey: string;
  descriptionKey: string;
  category: 'reclaim' | 'review' | 'quality';
  /** Why this template is shaped the way it is — shown in the picker. */
  rationaleKey: string;
  document: CleanupPolicyDocument;
}

const BASE_EXCLUSIONS = {
  protected: true as const,
  locked: true as const,
  activePlayback: true as const,
  incompleteDownload: true as const,
  inFlightOperation: true as const,
  ambiguousIdentity: true,
  requireMeasuredTechnical: true,
};

export const CLEANUP_POLICY_TEMPLATES: CleanupPolicyTemplate[] = [
  {
    key: 'old_unwatched_low_resolution_movies',
    nameKey: 'cleanup.template.oldUnwatchedLowRes.name',
    descriptionKey: 'cleanup.template.oldUnwatchedLowRes.desc',
    rationaleKey: 'cleanup.template.oldUnwatchedLowRes.rationale',
    category: 'reclaim',
    document: {
      schemaVersion: POLICY_DOCUMENT_SCHEMA_VERSION,
      scope: { libraryKinds: ['movie'] },
      conditions: {
        type: 'all',
        children: [
          { type: 'condition', field: 'metadata.releaseYear', operator: 'lt', value: 2001 },
          { type: 'condition', field: 'playback.completedPlayCount', operator: 'eq', value: 0 },
          // Authored as a label; compared as an ordinal.
          { type: 'condition', field: 'technical.resolutionClass', operator: 'lt', value: '1080p' },
        ],
      },
      exclusions: { ...BASE_EXCLUSIONS, addedWithinDays: 90 },
      // Approval-required, never automatic: "old and unwatched" is a heuristic about
      // taste, and a human should look before anything moves.
      action: { mode: 'approval_required', destination: 'trash', retentionDays: 30 },
      notes: 'Starter template. Review the candidates before approving anything.',
    },
  },
  {
    key: 'low_use_10bit_media',
    nameKey: 'cleanup.template.lowUse10bit.name',
    descriptionKey: 'cleanup.template.lowUse10bit.desc',
    rationaleKey: 'cleanup.template.lowUse10bit.rationale',
    category: 'review',
    document: {
      schemaVersion: POLICY_DOCUMENT_SCHEMA_VERSION,
      scope: { libraryKinds: ['movie', 'tv', 'anime'] },
      conditions: {
        type: 'all',
        children: [
          { type: 'condition', field: 'playback.completedPlayCount', operator: 'lt', value: 100 },
          { type: 'condition', field: 'technical.videoBitDepth', operator: 'eq', value: 10 },
        ],
      },
      exclusions: { ...BASE_EXCLUSIONS, addedWithinDays: 180 },
      // REPORT ONLY, deliberately. 10-bit is not a defect — it is usually the better
      // encode — so this template exists to show you what you have, not to delete it.
      action: { mode: 'report_only', destination: 'trash' },
      notes: 'Report-only by design: 10-bit video is not inherently undesirable.',
    },
  },
  {
    key: 'superseded_8bit_h264_with_replacement',
    nameKey: 'cleanup.template.supersededH264.name',
    descriptionKey: 'cleanup.template.supersededH264.desc',
    rationaleKey: 'cleanup.template.supersededH264.rationale',
    category: 'quality',
    document: {
      schemaVersion: POLICY_DOCUMENT_SCHEMA_VERSION,
      scope: { libraryKinds: ['movie', 'tv', 'anime'] },
      conditions: {
        type: 'all',
        children: [
          { type: 'condition', field: 'playback.completedPlayCount', operator: 'lt', value: 100 },
          { type: 'condition', field: 'technical.videoBitDepth', operator: 'eq', value: 10 },
          { type: 'condition', field: 'technical.videoCodec', operator: 'eq', value: 'x264' },
          { type: 'condition', field: 'technical.isHdr', operator: 'eq', value: false },
          { type: 'condition', field: 'storage.betterReplacementExists', operator: 'eq', value: true },
        ],
      },
      exclusions: { ...BASE_EXCLUSIONS, addedWithinDays: 180 },
      // The safest destructive shape: nothing goes unless a verified equal-or-better
      // copy of the same media survives it.
      replacement: {
        required: true,
        minResolutionClass: '1080p',
        requireProbeSucceeded: true,
        requireHdrAtLeastEqual: true,
      },
      action: { mode: 'approval_required', destination: 'quarantine', retentionDays: 30 },
      notes: 'Only removes a copy when a verified equal-or-better replacement exists.',
    },
  },
];

export function getTemplate(key: string): CleanupPolicyTemplate | undefined {
  return CLEANUP_POLICY_TEMPLATES.find((t) => t.key === key);
}
