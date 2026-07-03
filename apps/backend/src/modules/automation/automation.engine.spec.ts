import { AutomationEngine } from './automation.module';
import type { NormalizedTorrent } from '@ultratorrent/shared';

// A ratio-cap rule: when ratio >= 2, stop the torrent.
const RATIO_RULE = {
  id: 'r1',
  name: 'Stop at 2.0',
  conditions: [{ field: 'ratio', op: 'gte', value: 2 }],
  actions: [{ type: 'stop' }],
};

function torrent(over: Partial<NormalizedTorrent> = {}): NormalizedTorrent {
  return {
    hash: 'H',
    name: 't',
    ratio: 0,
    state: 'seeding',
    progress: 1,
    size: 1,
    downloaded: 1,
    uploaded: 1,
    downloadRate: 0,
    uploadRate: 0,
    eta: null,
    engineId: 'e1',
    ...over,
  } as NormalizedTorrent;
}

describe('AutomationEngine — ratio.reached edge trigger', () => {
  function make() {
    const provider = { stopTorrent: jest.fn().mockResolvedValue(undefined) };
    const prisma = {
      automationRule: { findMany: jest.fn().mockResolvedValue([RATIO_RULE]) },
      automationLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as any;
    const registry = { resolve: jest.fn().mockResolvedValue(provider) } as any;
    const notifications = { dispatch: jest.fn().mockResolvedValue(undefined) } as any;
    const media = {} as any;
    const engine = new AutomationEngine(prisma, registry, notifications, media);
    return { engine, provider };
  }

  it('fires when the ratio first crosses the threshold', async () => {
    const { engine, provider } = make();
    await engine.evaluateMany('ratio.reached', [
      { context: torrent({ ratio: 2.1 }), previous: torrent({ ratio: 1.9 }) },
    ]);
    expect(provider.stopTorrent).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-fire once the ratio was already above the threshold', async () => {
    const { engine, provider } = make();
    await engine.evaluateMany('ratio.reached', [
      { context: torrent({ ratio: 2.3 }), previous: torrent({ ratio: 2.1 }) },
    ]);
    expect(provider.stopTorrent).not.toHaveBeenCalled();
  });

  it('does not fire while still below the threshold', async () => {
    const { engine, provider } = make();
    await engine.evaluateMany('ratio.reached', [
      { context: torrent({ ratio: 1.5 }), previous: torrent({ ratio: 1.2 }) },
    ]);
    expect(provider.stopTorrent).not.toHaveBeenCalled();
  });

  it('skips all work when no rule uses the trigger (one cheap query)', async () => {
    const { engine, provider } = make();
    (engine as any).prisma.automationRule.findMany.mockResolvedValueOnce([]);
    await engine.evaluateMany('ratio.reached', [
      { context: torrent({ ratio: 2.1 }), previous: torrent({ ratio: 1.9 }) },
    ]);
    expect(provider.stopTorrent).not.toHaveBeenCalled();
  });
});
