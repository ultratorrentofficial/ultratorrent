/**
 * The cleanup policy document — the thing a published version freezes.
 *
 * It is DATA, never code: a condition names a catalogue id, an operator from the
 * fixed set, and a literal value. There is no expression language, so there is
 * nothing to eval.
 */

export const POLICY_DOCUMENT_SCHEMA_VERSION = 1;

/** Structural bounds. A policy that exceeds any of these is refused at validate time. */
export const POLICY_LIMITS = {
  maxConditions: 100,
  maxDepth: 5,
  maxGroupChildren: 50,
  maxDocumentBytes: 128 * 1024,
  maxCandidatesPerPlan: 5000,
  /** Nothing unattended may exceed this without an explicit operator override. */
  maxAutomaticReclaimBytesPerRun: 2 * 1024 ** 4, // 2 TiB
} as const;

export type PolicyMode = 'report_only' | 'approval_required' | 'auto_quarantine' | 'auto_trash';
export type PolicyDestination = 'quarantine' | 'trash';

export interface PolicyConditionLeaf {
  type: 'condition';
  /** A CLEANUP_CONDITIONS id. */
  field: string;
  operator: string;
  value: unknown;
  /** Opt into filename-inferred values for a condition that normally demands a probe. */
  allowInferred?: boolean;
}

export interface PolicyConditionGroup {
  /** `all` = AND, `any` = OR. */
  type: 'all' | 'any';
  children: PolicyConditionNode[];
}

export type PolicyConditionNode = PolicyConditionLeaf | PolicyConditionGroup;

export interface PolicyScope {
  libraryIds?: string[];
  libraryKinds?: string[];
  pathPrefixes?: string[];
}

/** Mandatory exclusions. These are enforced server-side regardless of the document. */
export interface PolicyExclusions {
  /** Always true in practice — present so the UI can show it is not optional. */
  protected: true;
  locked: true;
  activePlayback: true;
  incompleteDownload: true;
  inFlightOperation: true;
  /** Operator-tunable safety margins. */
  addedWithinDays?: number;
  ambiguousIdentity?: boolean;
  requireMeasuredTechnical?: boolean;
  maxPlaybackAggregateAgeDays?: number;
  /** Refuse a candidate whose max progress reached this, even with zero completions. */
  excludeIfProgressAbovePercent?: number;
}

export interface PolicyReplacementRequirements {
  required: boolean;
  minResolutionClass?: string;
  preferredCodecs?: string[];
  minAudioChannels?: number;
  requireSubtitleLanguages?: string[];
  requireHdrAtLeastEqual?: boolean;
  requireProbeSucceeded?: boolean;
}

export interface PolicyAction {
  mode: PolicyMode;
  destination: PolicyDestination;
  retentionDays?: number;
  /** Caps apply per run. Absent = the platform default, never unbounded. */
  maxItemsPerRun?: number;
  maxReclaimBytesPerRun?: number;
}

export interface PolicyStoragePressure {
  enabled: boolean;
  triggerBelowFreePercent?: number;
  stopAtFreePercent?: number;
  maxReclaimBytes?: number;
  maxRuntimeSeconds?: number;
}

export interface CleanupPolicyDocument {
  schemaVersion: number;
  scope: PolicyScope;
  conditions: PolicyConditionNode;
  exclusions: PolicyExclusions;
  replacement?: PolicyReplacementRequirements;
  action: PolicyAction;
  storagePressure?: PolicyStoragePressure;
  notes?: string;
}

export function isGroup(node: PolicyConditionNode): node is PolicyConditionGroup {
  return node.type === 'all' || node.type === 'any';
}

/** Every condition id the document references — drives the policy-scoped digest. */
export function collectFieldIds(node: PolicyConditionNode, out: Set<string> = new Set()): Set<string> {
  if (isGroup(node)) {
    for (const child of node.children) collectFieldIds(child, out);
  } else {
    out.add(node.field);
  }
  return out;
}

export function countConditions(node: PolicyConditionNode): number {
  return isGroup(node) ? node.children.reduce((n, c) => n + countConditions(c), 0) : 1;
}

export function documentDepth(node: PolicyConditionNode): number {
  return isGroup(node)
    ? 1 + node.children.reduce((d, c) => Math.max(d, documentDepth(c)), 0)
    : 1;
}
