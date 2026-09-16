import {
  ALL_MEDIA_RECOMMENDATION_TYPES,
  MEDIA_RECOMMENDATION_TYPES as T,
  PERMISSIONS,
} from '@ultratorrent/shared';

import {
  REMEDIATION_CAPABILITIES,
  capabilityFor,
  isPlannable,
} from './remediation-capabilities';

/**
 * What Phase 6 claims it can execute.
 *
 * This table is the only place that answer exists, so the tests that matter
 * are the ones stopping it from quietly growing a claim nothing backs: every
 * recommendation type classified, no automatic execution anywhere, and every
 * refusal carrying a reason a person can read.
 */

describe('the classification covers the whole catalogue', () => {
  it('classifies every recommendation type the evaluator can emit', () => {
    // A tenth type must force a decision here rather than defaulting to
    // "unclassified", which would read downstream as "not plannable" for a
    // reason nobody wrote down.
    const classified = REMEDIATION_CAPABILITIES.map((c) => c.type).sort();
    expect(classified).toEqual([...ALL_MEDIA_RECOMMENDATION_TYPES].sort());
  });

  it('classifies each type exactly once', () => {
    const seen = REMEDIATION_CAPABILITIES.map((c) => c.type);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('returns null for a type it has never heard of', () => {
    expect(capabilityFor('SOME_FUTURE_TYPE')).toBeNull();
  });
});

describe('nothing executes automatically', () => {
  it('declares supportsAutomatic false in every row', () => {
    /*
     * Not a placeholder. The platform has no autonomous actor: no system
     * principal, no service-level guard bypass, and a job's `runAsUserId` is
     * attribution rather than authority. Automatic execution would be a
     * platform change, not a Media Intelligence one.
     */
    for (const cap of REMEDIATION_CAPABILITIES) {
      expect(`${cap.type}:${cap.supportsAutomatic}`).toBe(`${cap.type}:false`);
    }
  });
});

describe('only what genuinely closes the loop is supported', () => {
  it('supports exactly one remediation type', () => {
    const supported = REMEDIATION_CAPABILITIES.filter((c) => c.supported).map((c) => c.type);
    expect(supported).toEqual([T.REFRESH_METADATA]);
  });

  it('routes the supported type at the domain that owns the mutation', () => {
    const cap = capabilityFor(T.REFRESH_METADATA)!;
    expect(cap.ownerDomain).toBe('media_manager');
    expect(cap.capabilityId).toBe('media.metadata.refresh');
    // The OWNING domain's permission, never a Media Intelligence one. The
    // executor is not a privilege proxy.
    expect(cap.requiredPermission).toBe(PERMISSIONS.MEDIA_MANAGER_EDIT_METADATA);
  });

  it('plans metadata refresh only where the entity id addresses a media item', () => {
    // movie and episode entity ids ARE MediaItem.id. A series id is a
    // MediaShow.id, there is no show-level refresh service and no tv_show
    // action, so a series plan would be a plan with no remedy.
    expect(isPlannable(T.REFRESH_METADATA, 'movie')).toBe(true);
    expect(isPlannable(T.REFRESH_METADATA, 'episode')).toBe(true);
    expect(isPlannable(T.REFRESH_METADATA, 'series')).toBe(false);
    expect(isPlannable(T.REFRESH_METADATA, 'season')).toBe(false);
  });

  it('never plans an unsupported type, whatever the entity', () => {
    for (const cap of REMEDIATION_CAPABILITIES.filter((c) => !c.supported)) {
      for (const entity of ['movie', 'series', 'season', 'episode']) {
        expect(`${cap.type}/${entity}:${isPlannable(cap.type, entity)}`).toBe(
          `${cap.type}/${entity}:false`,
        );
      }
    }
  });
});

describe('every refusal is explained', () => {
  it('gives each unsupported type at least one reason code', () => {
    for (const cap of REMEDIATION_CAPABILITIES.filter((c) => !c.supported)) {
      expect(cap.reasons.length).toBeGreaterThan(0);
    }
  });

  it('records no targetable entity type for an unsupported remediation', () => {
    // An unsupported row advertising entity types would let a caller believe
    // a plan could be built for one of them.
    for (const cap of REMEDIATION_CAPABILITIES.filter((c) => !c.supported)) {
      expect(cap.entityTypes).toEqual([]);
    }
  });

  it('refuses the quality upgrade for the reasons the audit established', () => {
    const cap = capabilityFor(T.SEARCH_FOR_QUALITY_UPGRADE)!;
    expect(cap.supported).toBe(false);
    // The reference flow the brief wanted. Each of these is a repository
    // fact, not a preference.
    expect(cap.reasons).toContain('replacement_identity_unprovable');
    expect(cap.reasons).toContain('old_copy_retirement_unknowable');
  });

  it('refuses subtitle search because succeeding would not resolve the drift', () => {
    const cap = capabilityFor(T.SEARCH_SUBTITLES)!;
    // The action is real and safe — that is not the test. Success must mean
    // source truth changed, and a search moves nothing.
    expect(cap.capabilityId).toBe('subtitles.search');
    expect(cap.supported).toBe(false);
    expect(cap.reasons).toContain('executing_resolves_no_drift');
  });

  it('refuses the two count-only findings for want of an identifier', () => {
    for (const type of [T.REVIEW_DUPLICATES, T.RECHECK_TORRENT]) {
      const cap = capabilityFor(type)!;
      // Both have a registered action; neither finding carries the id that
      // action takes.
      expect(cap.capabilityId).not.toBeNull();
      expect(cap.reasons).toContain('owning_domain_id_absent_from_evidence');
    }
  });

  it('refuses the intake retry because intake registers no action', () => {
    const cap = capabilityFor(T.RETRY_FAILED_INTAKE)!;
    // The near-miss: the identifier IS present, so the reason must be the
    // real one rather than the generic "no id".
    expect(cap.reasons).toEqual(['owning_domain_registers_no_action']);
    expect(cap.capabilityId).toBeNull();
  });
});

describe('risk is recorded independently of support', () => {
  it('marks the quality upgrade destructive even though it cannot run', () => {
    // Risk describes the act, not whether Phase 6 permits it. If this type is
    // ever enabled, it must not arrive classified `low` by omission.
    expect(capabilityFor(T.SEARCH_FOR_QUALITY_UPGRADE)!.riskClass).toBe('destructive');
  });

  it('marks the one executable remediation low risk', () => {
    // It writes metadata rows and nothing on disk.
    expect(capabilityFor(T.REFRESH_METADATA)!.riskClass).toBe('low');
  });
});
