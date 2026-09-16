import { createHash } from 'node:crypto';

/**
 * What "the world has not changed" means for a remediation plan.
 *
 * A plan is proposed against a specific desired state, a specific
 * recommendation, and — where one exists — a specific verified candidate.
 * Between proposal, approval and execution any of those can move: the
 * operator edits a policy, the drift resolves, a better release appears, the
 * candidate ages out. Executing anyway would carry out something nobody
 * approved, so the inputs are hashed and compared immediately before the
 * source call; a difference supersedes the plan rather than proceeding.
 *
 * Deliberately NOT `cleanup/domain/candidate-fingerprint.ts`, even though this
 * module already imports from that folder. That helper hashes a media FILE —
 * path, size, mtime, protections, replacement — which is the right shape for
 * deciding whether a file may be deleted and the wrong shape for every input
 * here. Borrowing it would mean passing six fields it does not want and
 * omitting every field it does. What is reused is its discipline, which is the
 * part that matters:
 *
 *   - sorted keys, so field order cannot change a hash;
 *   - explicit `null` and `∅` renderings, so absent and empty stay distinct;
 *   - no float ambiguity;
 *   - a diff function, so a supersession can say WHICH input moved rather
 *     than only that something did.
 *
 * Timestamps are never hashed. A fingerprint that changed every evaluation
 * would supersede every plan on the next sweep, which is indistinguishable
 * from the feature not working.
 */

/** Deterministic rendering of one value. Mirrors the cleanup helper exactly. */
function stringify(v: unknown): string {
  if (v === undefined) return '∅';
  if (v === null) return 'null';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return `[${v.map(stringify).join(',')}]`;
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, val]) => `${k}=${stringify(val)}`).join(',')}}`;
  }
  return String(v);
}

function hash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/* ------------------------------------------------------- desired state */

/**
 * The resolved intent a plan is answering.
 *
 * Only the dimensions and their winning policy — not the provenance detail.
 * An operator renaming a policy has not changed what they asked for, and
 * superseding every plan over a rename would teach people that "changed"
 * means nothing.
 */
export interface DesiredStateFingerprintInput {
  entityType: string;
  entityId: string;
  quality: string | null;
  completeness: string | null;
  subtitleLanguages: string[] | null;
  /** The mode that governs, since it decides whether approval is required. */
  mode: string | null;
  /** Policy ids that supplied a dimension, so a swap of source is detected. */
  sourcePolicyIds: string[];
  /** A conflicted dimension must never silently become unconflicted. */
  conflictedDimensions: string[];
}

export function desiredStateFingerprint(input: DesiredStateFingerprintInput): string {
  return hash([
    `entity:${input.entityType}:${input.entityId}`,
    `quality:${stringify(input.quality)}`,
    `completeness:${stringify(input.completeness)}`,
    // Sorted: a policy listing the same languages in another order expresses
    // the same requirement.
    `subtitles:${stringify(input.subtitleLanguages ? [...input.subtitleLanguages].sort() : null)}`,
    `mode:${stringify(input.mode)}`,
    `policies:${stringify([...input.sourcePolicyIds].sort())}`,
    `conflicts:${stringify([...input.conflictedDimensions].sort())}`,
  ]);
}

/* ------------------------------------------------------ recommendation */

/**
 * The proposal a plan carries out.
 *
 * `evidence` is included because it is what the recommendation rests on —
 * Phase 4 already treats a change in evidence as invalidating a verification,
 * and the same reasoning applies here.
 */
export interface RecommendationFingerprintInput {
  recommendationId: string;
  type: string;
  status: string;
  confidence: string;
  capabilityId: string | null;
  evidence: Record<string, unknown>;
}

export function recommendationFingerprint(input: RecommendationFingerprintInput): string {
  return hash([
    `recommendation:${input.recommendationId}`,
    `type:${input.type}`,
    `status:${input.status}`,
    `confidence:${input.confidence}`,
    `capability:${stringify(input.capabilityId)}`,
    `evidence:${stringify(input.evidence)}`,
  ]);
}

/* -------------------------------------------------------- verification */

/**
 * The candidate a plan would act on, when one exists.
 *
 * `verifiedAt` IS hashed here, unlike everywhere else, and deliberately: a
 * re-verification that returns the same release is still new evidence, and a
 * plan pinned to a twelve-hour-old check must not pass as current. Freshness
 * is the property this fingerprint exists to protect.
 *
 * No download URL, because the contract does not carry one — an indexer link
 * can hold an authentication token, and nothing here may reach a browser or a
 * plan row.
 */
export interface VerificationFingerprintInput {
  releaseName: string;
  indexerName: string;
  sizeBytes: number | null;
  matchedRung: number | null;
  verifiedAt: string | null;
}

export function verificationFingerprint(input: VerificationFingerprintInput): string {
  return hash([
    `release:${input.releaseName}`,
    `indexer:${input.indexerName}`,
    `size:${stringify(input.sizeBytes)}`,
    `rung:${stringify(input.matchedRung)}`,
    `verifiedAt:${stringify(input.verifiedAt)}`,
  ]);
}

/* --------------------------------------------------------------- diff */

/** Which pinned inputs moved, so a supersession can say why. */
export function fingerprintDrift(
  pinned: { desiredState?: string | null; recommendation?: string | null; verification?: string | null },
  current: { desiredState?: string | null; recommendation?: string | null; verification?: string | null },
): string[] {
  const drift: string[] = [];
  // A pin that was never taken cannot have drifted — only a pinned value that
  // no longer matches counts, or an approval would be invalidated by a field
  // the plan never depended on.
  if (pinned.desiredState && pinned.desiredState !== current.desiredState) drift.push('desired_state');
  if (pinned.recommendation && pinned.recommendation !== current.recommendation) {
    drift.push('recommendation');
  }
  if (pinned.verification && pinned.verification !== current.verification) drift.push('verification');
  return drift;
}
