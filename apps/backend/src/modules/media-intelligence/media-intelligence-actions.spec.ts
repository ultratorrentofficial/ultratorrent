import { MediaIntelligenceModule } from './media-intelligence.module';
import { MEDIA_INTELLIGENCE_ACTIONS } from './media-intelligence-actions';

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

  it('declares only disposition verbs — Phase 3 organises work, it does not do it', () => {
    const ids = MEDIA_INTELLIGENCE_ACTIONS.map((a) => a.id);
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
    for (const a of MEDIA_INTELLIGENCE_ACTIONS) {
      expect(a.entityTypes).toEqual(['finding']);
    }
  });

  it('gates on the permission that opens the queue, not the rebuild permission', () => {
    // Triage changes no media and no fact. Gating it behind `scan` would hand
    // most operators a list they are forbidden to clear.
    for (const a of MEDIA_INTELLIGENCE_ACTIONS) {
      expect(a.permissions).toEqual(['media_manager.view']);
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
