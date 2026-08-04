import { BadRequestException } from '@nestjs/common';
import { SchedulerActivationService } from './scheduler-activation.service';
import { SchedulerCapabilityService } from './scheduler-capability.service';

/**
 * Turning enforcement on, and off again.
 *
 * Activation is the moment UltraTorrent starts pausing torrents that belong to
 * someone else's queue, so these are about consent and reversibility: it cannot
 * happen without a preview and a confirmation, it cannot happen at all on an
 * engine that cannot pause, and switching it off does not start downloads nobody
 * chose to start.
 */
function build(opts: {
  kind?: string;
  decisions?: Array<{ action: string }>;
  parkingEnabled?: boolean;
  policyCount?: number;
  heldPaused?: string[];
} = {}) {
  const upserts: any[] = [];
  const resumed: string[] = [];
  const prisma = {
    torrentSchedulerEngineConfig: { upsert: jest.fn(async (a: any) => { upserts.push(a); return a; }) },
    torrentSchedulerPolicy: { count: jest.fn(async () => opts.policyCount ?? 1) },
    torrentSchedulerState: {
      findMany: jest.fn(async () => (opts.heldPaused ?? []).map((hash) => ({ hash }))),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
  };
  const provider = {
    engineId: 'e1',
    kind: opts.kind ?? 'qbittorrent',
    resumeTorrent: jest.fn(async (h: string) => { resumed.push(h); }),
  };
  const registry = {
    get: jest.fn((id: string) => {
      if (id !== 'e1') throw new Error('unknown');
      return provider;
    }),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const settings = { get: jest.fn(async () => ({ enabled: !!opts.parkingEnabled })) };
  const preview = {
    previewEngine: jest.fn(async () => ({
      engineId: 'e1',
      decisions: opts.decisions ?? [{ action: 'pause' }, { action: 'pause' }, { action: 'none' }],
      summary: {}, limitations: [],
    })),
  };
  const svc = new SchedulerActivationService(
    prisma as never, registry as never, audit as never, settings as never,
    new SchedulerCapabilityService(), preview as never,
  );
  return { svc, prisma, upserts, resumed, audit, provider };
}

describe('describing what activation would do', () => {
  it('counts the torrents that would actually change', async () => {
    const { svc } = build();
    const d = await svc.describe('e1');
    expect(d.wouldPause).toBe(2);
    expect(d.wouldResume).toBe(0);
    expect(d.blockers).toHaveLength(0);
  });

  it('blocks an engine that cannot pause', async () => {
    // Nothing else matters if the engine cannot relinquish a slot.
    const { svc } = build({ kind: 'transmission' });
    const d = await svc.describe('e1');
    expect(d.blockers.map((b) => b.code)).toContain('engine_cannot_pause');
  });

  it('warns that rTorrent infers its queue state and approximates force start', async () => {
    const { svc } = build({ kind: 'rtorrent' });
    const codes = (await svc.describe('e1')).warnings.map((w) => w.code);
    expect(codes).toContain('queued_state_inferred');
    expect(codes).toContain('force_start_approximated');
  });

  it('warns when the parking service is also pausing torrents', async () => {
    // Two systems pausing torrents on one engine is the conflict worth naming
    // BEFORE the second one starts, not after.
    const { svc } = build({ parkingEnabled: true });
    expect((await svc.describe('e1')).warnings.map((w) => w.code)).toContain('parking_also_enabled');
  });

  it('warns when no policies exist, because enforcement would do nothing', async () => {
    // Every limit is unlimited without a policy, so activation is a no-op. An
    // operator who enables it and sees no effect deserves to know why.
    const { svc } = build({ policyCount: 0 });
    expect((await svc.describe('e1')).warnings.map((w) => w.code)).toContain('no_policies');
  });

  it('rejects an unknown engine', async () => {
    const { svc } = build();
    await expect(svc.describe('nope')).rejects.toThrow();
  });
});

describe('activating', () => {
  it('refuses without confirmation, and says what would have happened', async () => {
    const { svc, upserts } = build();
    await expect(svc.activate('e1', false)).rejects.toBeInstanceOf(BadRequestException);
    // Nothing was written: a refused activation must not half-enable anything.
    expect(upserts).toHaveLength(0);
  });

  it('refuses on a blocked engine even when confirmed', async () => {
    // Confirmation is consent, not an override of capability.
    const { svc } = build({ kind: 'transmission' });
    await expect(svc.activate('e1', true)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enables managed mode once confirmed', async () => {
    const { svc, upserts } = build();
    await svc.activate('e1', true, 'user-1');
    expect(upserts[0].create.mode).toBe('managed');
    expect(upserts[0].update.mode).toBe('managed');
  });

  it('records honestly that no native settings could be captured', async () => {
    // Neither shipped engine exposes its queue settings through the provider, so
    // there is nothing to restore later. Storing an empty object would imply a
    // backup exists.
    const { svc, upserts } = build();
    await svc.activate('e1', true);
    expect(upserts[0].create.nativeSettingsSnapshot).toMatchObject({ captured: false });
  });

  it('audits the activation with what it expected to do', async () => {
    const { svc, audit } = build();
    await svc.activate('e1', true, 'user-1');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'torrent_scheduler.activated',
      metadata: expect.objectContaining({ wouldPause: 2 }),
    }));
  });
});

describe('deactivating', () => {
  it('returns to native and leaves scheduler-paused torrents alone by default', async () => {
    /*
     * The property that matters. Blanket-resuming would start downloads nobody
     * chose to start, on an engine whose own limits are about to take over
     * again. The count is reported so the operator can decide.
     */
    const { svc, upserts, resumed } = build({ heldPaused: ['a', 'b', 'c'] });
    const out = await svc.deactivate('e1', false);

    expect(upserts[0].update.mode).toBe('native');
    expect(out.heldPaused).toBe(3);
    expect(out.resumed).toBe(0);
    expect(resumed).toEqual([]);
  });

  it('resumes them only when explicitly asked', async () => {
    const { svc, resumed } = build({ heldPaused: ['a', 'b'] });
    const out = await svc.deactivate('e1', true);
    expect(out.resumed).toBe(2);
    expect(resumed).toEqual(['a', 'b']);
  });

  it('keeps resuming the rest when one torrent refuses', async () => {
    const { svc, provider } = build({ heldPaused: ['a', 'b', 'c'] });
    (provider.resumeTorrent as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('gone');
    });
    const out = await svc.deactivate('e1', true);
    expect(out.resumed).toBe(2);
  });
});
