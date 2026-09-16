import { RemediationPlanService } from './remediation-plan.service';
import { RemediationQueryService } from './remediation-query.service';
import { RemediationPlanExecutorService } from './plan-executor.service';
import { RemediationSweepService } from './remediation-sweep.service';
import { MediaIntelligenceModule } from '../media-intelligence.module';
import { MediaIntelligenceController } from '../media-intelligence.controller';
import { REMEDIATION_CAPABILITIES } from './remediation-capabilities';

/**
 * The Phase 6 providers are declared, and their constructors are satisfiable.
 *
 * Nest resolution failures appear ONLY at bootstrap — never in tsc, never in
 * an ordinary unit test — so a module that lists a provider it cannot build
 * ships a page with no controls and no error. Checked structurally here
 * rather than by booting the whole app, which needs a database.
 */
describe('Phase 6 DI', () => {
  const providers = Reflect.getMetadata('providers', MediaIntelligenceModule) as unknown[];

  it.each([
    ['RemediationPlanService', RemediationPlanService],
    ['RemediationQueryService', RemediationQueryService],
    ['RemediationPlanExecutorService', RemediationPlanExecutorService],
    ['RemediationSweepService', RemediationSweepService],
  ])('registers %s on the module', (_name, cls) => {
    expect(providers).toContain(cls);
  });

  it.each([
    ['RemediationPlanService', RemediationPlanService, 2],
    ['RemediationQueryService', RemediationQueryService, 1],
    ['RemediationPlanExecutorService', RemediationPlanExecutorService, 3],
    ['RemediationSweepService', RemediationSweepService, 3],
  ])('%s declares injectable constructor params Nest can resolve', (_n, cls, arity) => {
    // `design:paramtypes` is what Nest reads. A missing entry means an
    // unresolvable token, which is the failure that only shows at boot.
    const params = Reflect.getMetadata('design:paramtypes', cls) as unknown[] | undefined;
    expect(params).toBeDefined();
    expect(params).toHaveLength(arity);
    expect(params!.every((p) => typeof p === 'function')).toBe(true);
  });

  it('resolves every controller dependency, including the Phase 6 services', () => {
    /*
     * The controller gained two constructor arguments in Phase 6, and a
     * controller Nest cannot construct fails at boot with the same silence
     * as an unresolvable provider — never in tsc, never in a unit test.
     */
    const params = Reflect.getMetadata(
      'design:paramtypes',
      MediaIntelligenceController,
    ) as unknown[] | undefined;

    expect(params).toBeDefined();
    const unresolvable = (params ?? [])
      .map((p, i) => [i, p] as const)
      .filter(([, p]) => typeof p !== 'function');
    // An `undefined` entry is the signature of a circular import or a missing
    // token — the exact failure this spec exists to surface early.
    expect(unresolvable).toEqual([]);
  });
});

describe('the concurrency guarantee and the capability table are coupled', () => {
  /*
   * The active-plan unique index is partial on `recommendationId`, NOT on the
   * entity — so two recommendations for one title could each hold a live
   * plan. That is safe today only because exactly one recommendation type is
   * supported, which makes at most one plannable recommendation per entity.
   *
   * This test exists so that coupling fails loudly rather than silently: the
   * moment a second type is marked supported, two plans can target the same
   * media item concurrently, and the index has to become per-entity (or the
   * executor has to serialise on the entity) before that ships.
   */
  it('supports exactly one remediation type, or demands the index be revisited', () => {
    const supported = REMEDIATION_CAPABILITIES.filter((c) => c.supported);
    expect(supported).toHaveLength(1);
  });
});
