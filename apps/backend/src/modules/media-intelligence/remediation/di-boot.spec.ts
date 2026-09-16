import { RemediationPlanService } from './remediation-plan.service';
import { RemediationQueryService } from './remediation-query.service';
import { RemediationPlanExecutorService } from './plan-executor.service';
import { RemediationSweepService } from './remediation-sweep.service';
import { MediaIntelligenceModule } from '../media-intelligence.module';

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
});
