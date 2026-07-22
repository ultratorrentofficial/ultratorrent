import { getCondition } from './condition-catalog';
import {
  POLICY_DOCUMENT_SCHEMA_VERSION, POLICY_LIMITS, countConditions, documentDepth, isGroup,
  type CleanupPolicyDocument, type PolicyConditionNode,
} from './policy-document';

/**
 * Strict, side-effect-free validation of a cleanup policy document.
 *
 * A policy that passes may be published, and a published policy can delete files,
 * so this is the gate. It is deliberately stricter for the unattended modes: a
 * report-only policy may be sloppy because its worst outcome is a bad report,
 * while an auto_trash policy is refused unless it carries the safety margins that
 * make unattended deletion defensible.
 */

export interface PolicyValidationIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  /** Dotted location, e.g. "conditions.children[2]". */
  path?: string;
}

export interface PolicyValidationResult {
  valid: boolean;
  errors: PolicyValidationIssue[];
  warnings: PolicyValidationIssue[];
}

const AUTOMATIC_MODES = new Set(['auto_quarantine', 'auto_trash']);

export function validatePolicyDocument(doc: CleanupPolicyDocument): PolicyValidationResult {
  const errors: PolicyValidationIssue[] = [];
  const warnings: PolicyValidationIssue[] = [];
  const err = (code: string, message: string, path?: string) =>
    errors.push({ code, message, severity: 'error', path });
  const warn = (code: string, message: string, path?: string) =>
    warnings.push({ code, message, severity: 'warning', path });

  if (!doc || typeof doc !== 'object') {
    err('document.malformed', 'Policy document is not an object.');
    return { valid: false, errors, warnings };
  }

  if (doc.schemaVersion !== POLICY_DOCUMENT_SCHEMA_VERSION) {
    err('document.schema_version',
      `Unsupported document schemaVersion ${doc.schemaVersion}; expected ${POLICY_DOCUMENT_SCHEMA_VERSION}.`);
  }

  const bytes = Buffer.byteLength(JSON.stringify(doc ?? {}), 'utf8');
  if (bytes > POLICY_LIMITS.maxDocumentBytes) {
    err('document.too_large', `Document is ${bytes} bytes; the maximum is ${POLICY_LIMITS.maxDocumentBytes}.`);
  }

  // ── Conditions ──────────────────────────────────────────────────────────────
  if (!doc.conditions) {
    err('conditions.missing', 'A policy must define at least one condition.');
  } else {
    const total = countConditions(doc.conditions);
    if (total === 0) err('conditions.empty', 'A policy must define at least one condition.');
    if (total > POLICY_LIMITS.maxConditions) {
      err('conditions.too_many', `${total} conditions; the maximum is ${POLICY_LIMITS.maxConditions}.`);
    }
    const depth = documentDepth(doc.conditions);
    if (depth > POLICY_LIMITS.maxDepth) {
      err('conditions.too_deep', `Nesting depth ${depth}; the maximum is ${POLICY_LIMITS.maxDepth}.`);
    }
    validateNode(doc.conditions, 'conditions', doc, err, warn);
  }

  // ── Scope ───────────────────────────────────────────────────────────────────
  const scope = doc.scope ?? {};
  const scoped = (scope.libraryIds?.length ?? 0) + (scope.libraryKinds?.length ?? 0) + (scope.pathPrefixes?.length ?? 0);
  if (scoped === 0 && AUTOMATIC_MODES.has(doc.action?.mode)) {
    // An unscoped automatic policy addresses the entire library set at once.
    err('scope.unbounded_automatic',
      'An automatic policy must be scoped to at least one library, kind or path prefix.');
  } else if (scoped === 0) {
    warn('scope.unbounded', 'This policy is not scoped and will evaluate every library.');
  }
  for (const p of scope.pathPrefixes ?? []) {
    if (!p.startsWith('/')) err('scope.relative_path', `Path prefix "${p}" must be absolute.`, 'scope.pathPrefixes');
  }

  // ── Action ──────────────────────────────────────────────────────────────────
  const action = doc.action;
  if (!action) {
    err('action.missing', 'A policy must declare an action.');
  } else {
    if (!['report_only', 'approval_required', 'auto_quarantine', 'auto_trash'].includes(action.mode)) {
      err('action.mode_invalid', `Unknown action mode "${action.mode}".`, 'action.mode');
    }
    if (!['quarantine', 'trash'].includes(action.destination)) {
      // Permanent deletion is deliberately not a policy destination — it is a
      // manual, separately-permissioned operation only.
      err('action.destination_invalid',
        `Destination must be "quarantine" or "trash"; unattended permanent deletion is not available.`,
        'action.destination');
    }
    if (action.retentionDays != null && (action.retentionDays < 0 || action.retentionDays > 3650)) {
      err('action.retention_out_of_range', 'retentionDays must be between 0 and 3650.', 'action.retentionDays');
    }
    if (AUTOMATIC_MODES.has(action.mode)) {
      if (action.maxItemsPerRun == null && action.maxReclaimBytesPerRun == null) {
        err('action.uncapped_automatic',
          'An automatic policy must cap either maxItemsPerRun or maxReclaimBytesPerRun.', 'action');
      }
      if ((action.maxReclaimBytesPerRun ?? 0) > POLICY_LIMITS.maxAutomaticReclaimBytesPerRun) {
        err('action.cap_too_high',
          `maxReclaimBytesPerRun exceeds the ${POLICY_LIMITS.maxAutomaticReclaimBytesPerRun}-byte ceiling for automatic runs.`,
          'action.maxReclaimBytesPerRun');
      }
      if ((action.maxItemsPerRun ?? 0) > POLICY_LIMITS.maxCandidatesPerPlan) {
        err('action.items_cap_too_high',
          `maxItemsPerRun exceeds the ${POLICY_LIMITS.maxCandidatesPerPlan}-candidate plan limit.`,
          'action.maxItemsPerRun');
      }
    }
  }

  // ── Exclusions: the safety margins ──────────────────────────────────────────
  const ex = doc.exclusions;
  if (!ex) {
    err('exclusions.missing', 'A policy must declare its exclusions.');
  } else if (AUTOMATIC_MODES.has(doc.action?.mode)) {
    // Unattended deletion needs a grace period; a file added minutes ago has not
    // had the chance to be watched, probed, or corrected.
    if (!ex.addedWithinDays || ex.addedWithinDays < 1) {
      err('exclusions.no_grace_period',
        'An automatic policy must set a grace period (exclusions.addedWithinDays >= 1).', 'exclusions.addedWithinDays');
    }
    if (ex.requireMeasuredTechnical === false && usesMeasuredCondition(doc.conditions)) {
      err('exclusions.inferred_technical_automatic',
        'An automatic policy using technical conditions cannot accept filename-inferred values.',
        'exclusions.requireMeasuredTechnical');
    }
    if (ex.ambiguousIdentity === false && usesIdentityCondition(doc.conditions)) {
      warn('exclusions.ambiguous_allowed',
        'This policy matches on identity but does not exclude ambiguous items.');
    }
  }

  // ── Replacement ─────────────────────────────────────────────────────────────
  const rep = doc.replacement;
  if (rep?.required) {
    const hasRequirement =
      rep.minResolutionClass != null || (rep.preferredCodecs?.length ?? 0) > 0 ||
      rep.minAudioChannels != null || (rep.requireSubtitleLanguages?.length ?? 0) > 0 ||
      rep.requireHdrAtLeastEqual === true || rep.requireProbeSucceeded === true;
    if (!hasRequirement) {
      err('replacement.no_requirements',
        'Replacement-aware cleanup is enabled but declares no requirement a replacement must meet.', 'replacement');
    }
  }

  // ── Storage pressure ────────────────────────────────────────────────────────
  const sp = doc.storagePressure;
  if (sp?.enabled) {
    if (sp.triggerBelowFreePercent == null || sp.stopAtFreePercent == null) {
      err('storage_pressure.incomplete',
        'A storage-pressure policy needs both triggerBelowFreePercent and stopAtFreePercent.', 'storagePressure');
    } else if (sp.stopAtFreePercent <= sp.triggerBelowFreePercent) {
      // Otherwise the run can never reach its target and would not stop.
      err('storage_pressure.target_unreachable',
        'stopAtFreePercent must be greater than triggerBelowFreePercent.', 'storagePressure');
    }
    if (sp.maxReclaimBytes == null && sp.maxRuntimeSeconds == null) {
      err('storage_pressure.uncapped',
        'A storage-pressure run must cap maxReclaimBytes or maxRuntimeSeconds.', 'storagePressure');
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateNode(
  node: PolicyConditionNode,
  path: string,
  doc: CleanupPolicyDocument,
  err: (c: string, m: string, p?: string) => void,
  warn: (c: string, m: string, p?: string) => void,
): void {
  if (isGroup(node)) {
    if (!Array.isArray(node.children) || node.children.length === 0) {
      err('group.empty', 'A condition group must contain at least one condition.', path);
      return;
    }
    if (node.children.length > POLICY_LIMITS.maxGroupChildren) {
      err('group.too_wide',
        `A group has ${node.children.length} children; the maximum is ${POLICY_LIMITS.maxGroupChildren}.`, path);
    }
    node.children.forEach((c, i) => validateNode(c, `${path}.children[${i}]`, doc, err, warn));
    return;
  }

  const def = getCondition(node.field);
  if (!def) {
    err('condition.unknown', `Unknown condition "${node.field}".`, path);
    return;
  }
  if (!def.operators.includes(node.operator)) {
    err('condition.operator_unsupported',
      `Condition "${node.field}" does not support operator "${node.operator}" (allowed: ${def.operators.join(', ')}).`,
      path);
  }
  // Type coherence — a numeric comparison against a string would coerce silently.
  if (def.dataType === 'number' && typeof node.value !== 'number') {
    err('condition.value_type', `Condition "${node.field}" expects a number.`, path);
  }
  if (def.dataType === 'boolean' && typeof node.value !== 'boolean') {
    err('condition.value_type', `Condition "${node.field}" expects a boolean.`, path);
  }
  if (def.dataType === 'date' && typeof node.value !== 'string') {
    err('condition.value_type', `Condition "${node.field}" expects an ISO date string.`, path);
  }
  if (def.enumValues && typeof node.value === 'string' && !def.enumValues.includes(node.value)) {
    err('condition.value_not_allowed',
      `"${node.value}" is not a valid value for "${node.field}" (allowed: ${def.enumValues.join(', ')}).`, path);
  }
  if (node.allowInferred && def.requiresMeasuredData && AUTOMATIC_MODES.has(doc.action?.mode)) {
    err('condition.inferred_in_automatic',
      `Condition "${node.field}" opts into inferred data, which an automatic policy may not do.`, path);
  }
  if (node.allowInferred && def.requiresMeasuredData) {
    warn('condition.inferred',
      `Condition "${node.field}" accepts filename-inferred values, which are a hint rather than a measurement.`, path);
  }
}

function usesMeasuredCondition(node: PolicyConditionNode): boolean {
  if (isGroup(node)) return node.children.some(usesMeasuredCondition);
  return getCondition(node.field)?.requiresMeasuredData === true;
}

function usesIdentityCondition(node: PolicyConditionNode): boolean {
  if (isGroup(node)) return node.children.some(usesIdentityCondition);
  const id = node.field;
  return id.startsWith('metadata.') || id === 'storage.isDuplicate' || id === 'storage.betterReplacementExists';
}
