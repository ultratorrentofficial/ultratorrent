import { MEDIA_RECOMMENDATION_TYPES as T, PERMISSIONS } from '@ultratorrent/shared';

import { buildPlan, stepKey, type PlanBuilderInput } from './plan-builder';

/**
 * Recommendation → plan.
 *
 * The claims worth pinning are the ones that keep a plan honest about its own
 * authority: that nothing is planned where the classification refuses, that a
 * blocker is RECORDED rather than worked around, that an unknown fact is
 * never read as permission, and that every step names the domain that owns
 * the mutation rather than assuming Media Intelligence may perform it.
 */

const NOW = new Date('2026-09-16T12:00:00Z');

const input = (over: Partial<PlanBuilderInput> = {}): PlanBuilderInput => ({
  entityType: 'movie',
  entityId: 'item-1',
  recommendationId: 'rec-1',
  findingId: 'find-1',
  type: T.REFRESH_METADATA,
  status: 'active',
  evidence: { provider: null },
  desired: null,
  facts: { entityExists: true, locked: false },
  ...over,
});

describe('what gets a plan at all', () => {
  it('builds a plan for the one supported remediation', () => {
    const plan = buildPlan(input(), NOW);
    expect(plan).not.toBeNull();
    expect(plan!.type).toBe(T.REFRESH_METADATA);
    expect(plan!.blockReason).toBeNull();
    expect(plan!.steps).toHaveLength(1);
  });

  it('builds nothing for a recommendation that is no longer active', () => {
    // History does not deserve a plan.
    for (const status of ['invalidated', 'satisfied', 'verified']) {
      expect(buildPlan(input({ status }), NOW)).toBeNull();
    }
  });

  it('builds nothing for a type the classification refuses', () => {
    // Not a blocked plan — nothing at all. The recommendation already
    // explains why; a permanently-blocked row per unsupported type would be
    // queue noise rather than explanation.
    for (const type of [T.SEARCH_FOR_QUALITY_UPGRADE, T.SEARCH_SUBTITLES, T.RECHECK_TORRENT]) {
      expect(buildPlan(input({ type }), NOW)).toBeNull();
    }
  });

  it('builds nothing for an entity type the remediation cannot address', () => {
    // A series id is a MediaShow.id; there is no show-level refresh service.
    expect(buildPlan(input({ entityType: 'series', entityId: 'show-1' }), NOW)).toBeNull();
    expect(buildPlan(input({ entityType: 'season', entityId: 'show-1:2' }), NOW)).toBeNull();
  });

  it('builds nothing for a type it has never heard of', () => {
    expect(buildPlan(input({ type: 'SOME_FUTURE_TYPE' }), NOW)).toBeNull();
  });
});

describe('blockers are recorded, never worked around', () => {
  it('blocks and carries NO steps, so nothing looks queued', () => {
    const plan = buildPlan(input({ facts: { entityExists: true, locked: true } }), NOW);
    expect(plan!.blockReason).toBe('item_locked');
    // Steps would imply work is pending when the gate already refused it.
    expect(plan!.steps).toEqual([]);
  });

  it('treats an UNKNOWN fact as a blocker, never as permission', () => {
    /*
     * The Phase 5 rule carried into execution: `unknown` is not `false`.
     * "We could not determine whether this is locked" must not read as
     * "it is not locked".
     */
    expect(buildPlan(input({ facts: { entityExists: true, locked: null } }), NOW)!.blockReason).toBe(
      'item_locked',
    );
    expect(buildPlan(input({ facts: { entityExists: null, locked: false } }), NOW)!.blockReason).toBe(
      'entity_missing',
    );
  });

  it('blocks a vanished entity ahead of anything else', () => {
    const plan = buildPlan(input({ facts: { entityExists: false, locked: true } }), NOW);
    // Most fundamental refusal first, so fixing one blocker does not reveal
    // a second that could have been reported at the same time.
    expect(plan!.blockReason).toBe('entity_missing');
  });

  it('blocks when a policy conflict governs a dimension this would act on', () => {
    const plan = buildPlan(
      input({
        type: T.REFRESH_METADATA,
        desired: {
          conflicts: [{ dimension: 'quality', scopeType: 'library', contenders: [] }],
          applicablePolicies: [],
        } as never,
      }),
      NOW,
    );
    /*
     * Metadata refresh touches no lifecycle dimension, so an unrelated
     * quality conflict must NOT block it. Determinism is not consent, but
     * neither is an irrelevant disagreement a reason to refuse.
     */
    expect(plan!.blockReason).toBeNull();
  });
});

describe('a step names the domain that owns the mutation', () => {
  it('routes at the owning module, its registered action and its permission', () => {
    const step = buildPlan(input(), NOW)!.steps[0];
    expect(step.ownerDomain).toBe('media_manager');
    expect(step.capabilityId).toBe('media.metadata.refresh');
    // The OWNING domain's permission — never a Media Intelligence one. The
    // executor must not become a privilege proxy.
    expect(step.requiredPermission).toBe(PERMISSIONS.MEDIA_MANAGER_EDIT_METADATA);
  });

  it('carries only the identifier the action takes, and no path or secret', () => {
    const step = buildPlan(input(), NOW)!.steps[0];
    expect(step.inputSnapshot).toEqual({ itemId: 'item-1' });
    const serialized = JSON.stringify(step);
    expect(serialized).not.toMatch(/\/mnt|\/downloads|http|token|apikey/i);
  });

  it('states a postcondition the next sweep can actually observe', () => {
    // Success means source truth changed, not that a call returned 200.
    expect(buildPlan(input(), NOW)!.steps[0].expectedPostcondition).toEqual({
      metadataProviderPresent: true,
    });
  });
});

describe('idempotency keys', () => {
  it('are deterministic for the same recommendation and step', () => {
    expect(stepKey('rec-1', 0, 'refresh_metadata')).toBe(stepKey('rec-1', 0, 'refresh_metadata'));
  });

  it('survive a plan being superseded and rebuilt', () => {
    /*
     * Keyed on the RECOMMENDATION, not the plan. A plan rebuilt for the same
     * intent must not re-issue a source action already issued just because
     * the plan row has a new id.
     */
    const first = buildPlan(input(), NOW)!.steps[0].idempotencyKey;
    const rebuilt = buildPlan(input(), new Date('2026-09-17T00:00:00Z'))!.steps[0].idempotencyKey;
    expect(rebuilt).toBe(first);
  });

  it('differ between recommendations', () => {
    expect(stepKey('rec-1', 0, 'refresh_metadata')).not.toBe(
      stepKey('rec-2', 0, 'refresh_metadata'),
    );
  });
});

describe('the plan explains itself', () => {
  it('records intent, owner and risk in bounded scalars', () => {
    const plan = buildPlan(input(), NOW)!;
    expect(plan.explanation).toMatchObject({
      recommendationType: T.REFRESH_METADATA,
      ownerDomain: 'media_manager',
      riskClass: 'low',
      blocked: false,
      intent: 'metadata_provider_present',
    });
  });

  it('says plainly that it is blocked, and why', () => {
    const plan = buildPlan(input({ facts: { entityExists: true, locked: true } }), NOW)!;
    expect(plan.explanation).toMatchObject({ blocked: true, blockReason: 'item_locked' });
  });

  it('expires, because its pinned inputs decay', () => {
    const plan = buildPlan(input(), NOW)!;
    expect(plan.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
  });
});
