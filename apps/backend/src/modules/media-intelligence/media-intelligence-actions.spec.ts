import { MediaIntelligenceModule } from './media-intelligence.module';
import { MEDIA_INTELLIGENCE_ACTIONS } from './media-intelligence-actions';

/*
 * Phase 4 widened this module's contract, so the invariants are partitioned
 * rather than loosened. The finding actions keep every assertion Phase 3
 * wrote, word for word; the recommendation action gets its own, equally
 * strict set. Relaxing the originals into "some actions" would delete the
 * tripwire that exists to catch remediation being bolted onto this module.
 */
const findingActions = MEDIA_INTELLIGENCE_ACTIONS.filter((a) => a.id.startsWith('attention.finding.'));
const recommendationActions = MEDIA_INTELLIGENCE_ACTIONS.filter((a) => a.id.startsWith('recommendation.'));

/**
 * The CAMA declarations, and that they actually reach the registry.
 *
 * A booted application context proves the graph resolves but not that
 * `onModuleInit` ran — and a module that declares actions nobody registers
 * produces a page with no controls and no error. So the hook is invoked
 * directly here against a fake registry, which is both faster and a stronger
 * assertion than watching a real boot succeed.
 */

describe('MEDIA_INTELLIGENCE_ACTIONS', () => {
  it('registers every declared action at module init', () => {
    const registerAll = jest.fn();
    const module = new MediaIntelligenceModule({ registerAll } as never);

    module.onModuleInit();

    expect(registerAll).toHaveBeenCalledTimes(1);
    const registered = (registerAll.mock.calls[0][0] as Array<{ id: string }>).map((a) => a.id);
    expect(registered).toEqual(MEDIA_INTELLIGENCE_ACTIONS.map((a) => a.id));
  });

  it('declares only disposition verbs for findings — organising work is not doing it', () => {
    const ids = findingActions.map((a) => a.id);
    expect(ids).toEqual([
      'attention.finding.acknowledge',
      'attention.finding.snooze',
      'attention.finding.dismiss',
      'attention.finding.reset',
    ]);
    // No search, no upgrade, no delete: remediation belongs to the module
    // that owns the media, with that module's own permission.
    for (const id of ids) {
      expect(id).not.toMatch(/search|upgrade|delete|fix|retry/);
    }
  });

  it('targets findings, which have a row and an id of their own', () => {
    for (const a of findingActions) {
      expect(a.entityTypes).toEqual(['finding']);
    }
  });

  it('gates disposition on the permission that opens the queue, not the rebuild one', () => {
    // Triage changes no media and no fact. Gating it behind `scan` would hand
    // most operators a list they are forbidden to clear.
    for (const a of findingActions) {
      expect(a.permissions).toEqual(['media_manager.view']);
    }
  });

  /* ------------------------------------------------- Phase 4: recommendations */

  it('offers exactly ONE recommendation action, and it is not a remediation verb', () => {
    expect(recommendationActions.map((a) => a.id)).toEqual(['recommendation.verify']);
    // Verifying asks whether a better release can be obtained. It downloads
    // nothing, deletes nothing and replaces nothing — remediation stays with
    // the module that owns the media, behind that module's own permission.
    for (const a of recommendationActions) {
      expect(a.id).not.toMatch(/delete|remove|grab|download|replace|acquire|upgrade/);
    }
  });

  it('gates verification on `scan`, because it reaches outside the installation', () => {
    // The only Media Intelligence operation that talks to an indexer. Reading
    // the queue must never be able to make the system go and ask one, so this
    // deliberately does NOT share the `view` the list reads under.
    for (const a of recommendationActions) {
      expect(a.permissions).toEqual(['media_manager.scan']);
      expect(a.entityTypes).toEqual(['recommendation']);
    }
  });

  it('keeps verification single-target — no library-wide provider fan-out', () => {
    // "Verify every upgrade in my library" is a policy decision, not a button,
    // and fanning out across thousands of titles is the provider stampede this
    // layer exists to avoid.
    for (const a of recommendationActions) {
      expect(a.arity).toBe('single');
    }
  });

  it('marks nothing destructive — dismissal deletes nothing', () => {
    for (const a of MEDIA_INTELLIGENCE_ACTIONS) {
      expect(a.destructive).toBeUndefined();
    }
  });

  it('requires an entity capability, so a resolved finding offers nothing', () => {
    for (const a of MEDIA_INTELLIGENCE_ACTIONS) {
      expect(a.requiresEntityCapability).toBeTruthy();
    }
  });
});
