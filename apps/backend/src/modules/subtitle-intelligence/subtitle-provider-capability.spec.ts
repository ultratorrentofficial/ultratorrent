/**
 * Provider availability driving the action catalogue.
 *
 * The property the framework promises: when no subtitle provider can be
 * reached, the provider-dependent actions leave the catalogue rather than
 * remaining as buttons that fail on click — and they come back when one
 * recovers, with no redeploy.
 */
import { SystemRole } from '@ultratorrent/shared';
import { CapabilityRegistry } from '../context-actions/capability-registry.service';
import { ContextActionService } from '../context-actions/context-action.service';
import { SubtitleProviderSettingsService } from './providers/subtitle-provider-settings.service';
import { SUBTITLE_ACTIONS, SUBTITLE_PROVIDER_CAPABILITY } from './subtitle-actions';

/** A module registry with subtitle_intelligence enabled. */
const modules = {
  isEnabled: () => true,
  getStatuses: () => [{ id: 'subtitle_intelligence', enabled: true, features: [] }],
} as any;

const admin = { id: 'u1', username: 'a', roles: [SystemRole.SUPER_ADMIN], permissions: [] };

function build(healthyCount: number | Error) {
  const registry = new CapabilityRegistry();
  registry.registerAll(SUBTITLE_ACTIONS);

  const prisma = {
    subtitleProviderConfig: {
      count: jest.fn(async () => {
        if (healthyCount instanceof Error) throw healthyCount;
        return healthyCount;
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };

  const settings = new SubtitleProviderSettingsService(prisma as any, {} as any, registry);
  return { registry, settings, prisma, service: new ContextActionService(registry, modules) };
}

const idsFor = (service: ContextActionService) =>
  service.catalogFor(admin as any).actions.map((a) => a.id);

describe('subtitle provider availability', () => {
  it('withholds search when no provider is healthy', async () => {
    const { settings, service } = build(0);
    await settings.publishActionCapability();
    expect(idsFor(service)).not.toContain('subtitles.search');
  });

  it('offers it once a provider is healthy', async () => {
    const { settings, service } = build(1);
    await settings.publishActionCapability();
    expect(idsFor(service)).toContain('subtitles.search');
  });

  it('declares only actions whose endpoint accepts a media item', () => {
    /*
     * Download takes a subtitle *candidate* and synchronise takes a completed
     * *download* — neither takes a media item. Both were declared against
     * media_item in the first draft and would have rendered buttons whose
     * endpoints reject what the surface sends.
     */
    const { service } = build(1);
    const ids = idsFor(service);
    expect(ids).not.toContain('subtitles.download');
    expect(ids).not.toContain('subtitles.sync');
  });

  it('restores the action when a provider recovers, with no restart', async () => {
    const { registry, settings, service } = build(0);
    await settings.publishActionCapability();
    expect(idsFor(service)).not.toContain('subtitles.search');

    registry.setProviderCapability(SUBTITLE_PROVIDER_CAPABILITY, true);
    expect(idsFor(service)).toContain('subtitles.search');
  });

  it('publishes availability from recordHealth, the path every check goes through', async () => {
    // Wiring this at the choke point rather than at each caller is what stops a
    // future health path from silently leaving the catalogue stale.
    const { settings, service } = build(1);
    await settings.recordHealth('opensubtitles', { healthy: true });
    expect(idsFor(service)).toContain('subtitles.search');
  });

  it('leaves the previous value alone when the lookup fails', async () => {
    /*
     * A transient database error must not remove the actions (which would read
     * as the feature vanishing) nor assert them (which would offer downloads
     * that cannot run). It holds what it had.
     */
    const { registry, settings, service } = build(new Error('db down'));
    registry.setProviderCapability(SUBTITLE_PROVIDER_CAPABILITY, true);

    await expect(settings.publishActionCapability()).resolves.toBeUndefined();
    expect(idsFor(service)).toContain('subtitles.search');
  });
});
