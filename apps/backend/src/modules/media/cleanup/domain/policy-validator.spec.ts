import { validatePolicyDocument } from './policy-validator';
import { POLICY_DOCUMENT_SCHEMA_VERSION, type CleanupPolicyDocument } from './policy-document';

const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);
const warnCodes = (r: { warnings: { code: string }[] }) => r.warnings.map((w) => w.code);

/** A valid report-only policy: the brief's "old unwatched low-resolution movies". */
function reportOnly(over: Partial<CleanupPolicyDocument> = {}): CleanupPolicyDocument {
  return {
    schemaVersion: POLICY_DOCUMENT_SCHEMA_VERSION,
    scope: { libraryKinds: ['movie'] },
    conditions: {
      type: 'all',
      children: [
        { type: 'condition', field: 'metadata.releaseYear', operator: 'lt', value: 2001 },
        { type: 'condition', field: 'playback.completedPlayCount', operator: 'eq', value: 0 },
      ],
    },
    exclusions: {
      protected: true, locked: true, activePlayback: true,
      incompleteDownload: true, inFlightOperation: true,
      addedWithinDays: 90, ambiguousIdentity: true, requireMeasuredTechnical: true,
    },
    action: { mode: 'report_only', destination: 'trash' },
    ...over,
  };
}

/** The same policy escalated to unattended trashing. */
function autoTrash(over: Partial<CleanupPolicyDocument> = {}): CleanupPolicyDocument {
  return reportOnly({
    action: { mode: 'auto_trash', destination: 'trash', retentionDays: 30, maxItemsPerRun: 100 },
    ...over,
  });
}

describe('a well-formed policy', () => {
  it('accepts a report-only policy', () => {
    const r = validatePolicyDocument(reportOnly());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('accepts a properly-capped automatic policy', () => {
    expect(validatePolicyDocument(autoTrash()).valid).toBe(true);
  });
});

describe('structural bounds', () => {
  it('rejects a document with no conditions', () => {
    const r = validatePolicyDocument(reportOnly({ conditions: undefined as any }));
    expect(codes(r)).toContain('conditions.missing');
  });

  it('rejects an empty group', () => {
    const r = validatePolicyDocument(reportOnly({ conditions: { type: 'all', children: [] } }));
    expect(codes(r)).toContain('group.empty');
  });

  it('rejects excessive nesting', () => {
    let node: any = { type: 'condition', field: 'metadata.releaseYear', operator: 'lt', value: 2001 };
    for (let i = 0; i < 8; i++) node = { type: 'all', children: [node] };
    const r = validatePolicyDocument(reportOnly({ conditions: node }));
    expect(codes(r)).toContain('conditions.too_deep');
  });

  it('rejects an over-wide group', () => {
    const children = Array.from({ length: 60 }, () => ({
      type: 'condition' as const, field: 'metadata.releaseYear', operator: 'lt', value: 2001,
    }));
    const r = validatePolicyDocument(reportOnly({ conditions: { type: 'all', children } }));
    expect(codes(r)).toContain('group.too_wide');
  });

  it('rejects a wrong schema version', () => {
    const r = validatePolicyDocument(reportOnly({ schemaVersion: 99 }));
    expect(codes(r)).toContain('document.schema_version');
  });
});

describe('condition coherence', () => {
  it('rejects an unknown condition', () => {
    const r = validatePolicyDocument(reportOnly({
      conditions: { type: 'condition', field: 'metadata.nope', operator: 'eq', value: 1 },
    }));
    expect(codes(r)).toContain('condition.unknown');
  });

  it('rejects an operator the condition does not support', () => {
    const r = validatePolicyDocument(reportOnly({
      conditions: { type: 'condition', field: 'metadata.mediaKind', operator: 'gt', value: 'movie' },
    }));
    expect(codes(r)).toContain('condition.operator_unsupported');
  });

  // A numeric comparison against a string would coerce silently and match things
  // the author never intended.
  it('rejects a value of the wrong type', () => {
    const r = validatePolicyDocument(reportOnly({
      conditions: { type: 'condition', field: 'metadata.releaseYear', operator: 'lt', value: '2001' },
    }));
    expect(codes(r)).toContain('condition.value_type');
  });

  it('rejects a value outside an enum', () => {
    const r = validatePolicyDocument(reportOnly({
      conditions: { type: 'condition', field: 'metadata.mediaKind', operator: 'eq', value: 'hologram' },
    }));
    expect(codes(r)).toContain('condition.value_not_allowed');
  });
});

describe('automatic modes are held to a higher bar', () => {
  it('refuses an unscoped automatic policy but only warns for report-only', () => {
    const auto = validatePolicyDocument(autoTrash({ scope: {} }));
    expect(codes(auto)).toContain('scope.unbounded_automatic');
    const report = validatePolicyDocument(reportOnly({ scope: {} }));
    expect(report.valid).toBe(true);
    expect(warnCodes(report)).toContain('scope.unbounded');
  });

  it('refuses an uncapped automatic policy', () => {
    const r = validatePolicyDocument(autoTrash({
      action: { mode: 'auto_trash', destination: 'trash' },
    }));
    expect(codes(r)).toContain('action.uncapped_automatic');
  });

  it('refuses a cap above the automatic ceiling', () => {
    const r = validatePolicyDocument(autoTrash({
      action: { mode: 'auto_trash', destination: 'trash', maxReclaimBytesPerRun: 99 * 1024 ** 4 },
    }));
    expect(codes(r)).toContain('action.cap_too_high');
  });

  // A file added minutes ago has not had the chance to be watched, probed or
  // corrected — unattended deletion needs a grace period.
  it('refuses an automatic policy with no grace period', () => {
    const r = validatePolicyDocument(autoTrash({
      exclusions: { ...reportOnly().exclusions, addedWithinDays: undefined },
    }));
    expect(codes(r)).toContain('exclusions.no_grace_period');
  });

  it('refuses an automatic policy that accepts inferred technical data', () => {
    const withTech = autoTrash({
      conditions: {
        type: 'all',
        children: [{ type: 'condition', field: 'technical.videoBitDepth', operator: 'eq', value: 10 }],
      },
      exclusions: { ...reportOnly().exclusions, requireMeasuredTechnical: false },
    });
    expect(codes(validatePolicyDocument(withTech))).toContain('exclusions.inferred_technical_automatic');
  });

  it('refuses a per-condition inferred opt-in inside an automatic policy', () => {
    const r = validatePolicyDocument(autoTrash({
      conditions: {
        type: 'all',
        children: [{ type: 'condition', field: 'technical.videoBitDepth', operator: 'eq', value: 10, allowInferred: true }],
      },
    }));
    expect(codes(r)).toContain('condition.inferred_in_automatic');
  });

  it('allows an inferred opt-in in report-only, but warns', () => {
    const r = validatePolicyDocument(reportOnly({
      conditions: {
        type: 'all',
        children: [{ type: 'condition', field: 'technical.videoBitDepth', operator: 'eq', value: 10, allowInferred: true }],
      },
    }));
    expect(r.valid).toBe(true);
    expect(warnCodes(r)).toContain('condition.inferred');
  });
});

describe('destination and destructive limits', () => {
  // Unattended permanent deletion is deliberately unavailable: permanent removal is
  // a manual, separately-permissioned operation.
  it('refuses permanent deletion as a policy destination', () => {
    const r = validatePolicyDocument(reportOnly({
      action: { mode: 'approval_required', destination: 'permanent_delete' as any },
    }));
    expect(codes(r)).toContain('action.destination_invalid');
  });

  it('rejects an out-of-range retention', () => {
    const r = validatePolicyDocument(reportOnly({
      action: { mode: 'approval_required', destination: 'trash', retentionDays: -5 },
    }));
    expect(codes(r)).toContain('action.retention_out_of_range');
  });
});

describe('replacement and storage pressure', () => {
  it('refuses replacement-aware cleanup with no stated requirement', () => {
    const r = validatePolicyDocument(reportOnly({ replacement: { required: true } }));
    expect(codes(r)).toContain('replacement.no_requirements');
  });

  it('accepts replacement with a requirement', () => {
    const r = validatePolicyDocument(reportOnly({ replacement: { required: true, minResolutionClass: '1080p' } }));
    expect(r.valid).toBe(true);
  });

  // A stop target at or below the trigger can never be reached, so the run would
  // not stop on its own.
  it('refuses an unreachable storage-pressure target', () => {
    const r = validatePolicyDocument(reportOnly({
      storagePressure: { enabled: true, triggerBelowFreePercent: 15, stopAtFreePercent: 10, maxReclaimBytes: 1024 },
    }));
    expect(codes(r)).toContain('storage_pressure.target_unreachable');
  });

  it('refuses an uncapped storage-pressure run', () => {
    const r = validatePolicyDocument(reportOnly({
      storagePressure: { enabled: true, triggerBelowFreePercent: 15, stopAtFreePercent: 20 },
    }));
    expect(codes(r)).toContain('storage_pressure.uncapped');
  });

  it('accepts a well-formed storage-pressure policy', () => {
    const r = validatePolicyDocument(reportOnly({
      storagePressure: { enabled: true, triggerBelowFreePercent: 15, stopAtFreePercent: 20, maxReclaimBytes: 2 * 1024 ** 4 },
    }));
    expect(r.valid).toBe(true);
  });
});
