/**
 * The gate that keeps existing installs untouched.
 *
 * This is the single condition the whole backward-compatibility promise rests
 * on: a completed torrent is taken up only if it traces back to an RSS rule
 * explicitly marked `managed_intake`. Every rule that predates this feature
 * reads `legacy_direct`, so on an upgraded install this handler finds nothing
 * managed and returns — for every torrent, forever, until somebody opts a rule
 * in deliberately.
 *
 * If any test in this file starts passing for the wrong reason, an upgrade
 * silently changes where a user's downloads land.
 */
import { DOMAIN_EVENTS } from '@ultratorrent/shared';
import { IntakeTriggerService } from './intake-trigger.service';

type Handler = (e: unknown) => void;

function build(opts: {
  rule?: { id: string; name: string; importMode: string; storageProfileId: string | null } | null;
  acquisition?: { rssRuleId: string | null } | null;
  /** A missing-episode grab's own trace, used when no rss_acquisition exists. */
  wanted?: { intakeRuleId: string | null } | null;
  profile?: { id: string; name: string } | null;
  /** The operator's own add-time decision, when they made one. */
  intent?: { engineId: string; profileId: string } | null;
  /** Every intent still waiting for its download, for the sweeper. */
  pendingIntents?: { hash: string; engineId: string; profileId: string }[];
  /** What the engine says it holds, for the sweeper. */
  engineTorrents?: { hash: string; progress: number; contentPath?: string; savePath?: string }[] | null;
} = {}) {
  const handlers = new Map<string, Handler>();
  const enqueued: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const consumed: Record<string, unknown>[] = [];

  const prisma = {
    rssAcquisition: {
      findFirst: jest.fn(async () =>
        opts.acquisition === undefined ? { rssRuleId: 'rule-1' } : opts.acquisition),
    },
    rssRule: { findUnique: jest.fn(async () => opts.rule ?? null) },
    wantedEpisode: { findFirst: jest.fn(async () => opts.wanted ?? null) },
    intakeIntent: {
      findFirst: jest.fn(async () => opts.intent ?? null),
      findMany: jest.fn(async () => opts.pendingIntents ?? []),
      updateMany: jest.fn(async (args: Record<string, unknown>) => {
        consumed.push(args);
        return { count: 1 };
      }),
    },
  };
  const moduleRef = {
    get: jest.fn(() => ({
      list: async () =>
        opts.engineTorrents === null ? {} : { items: opts.engineTorrents ?? [] },
    })),
  };
  const bus = { subscribe: jest.fn((key: string, fn: Handler) => handlers.set(key, fn)) };
  const intake = {
    enqueue: jest.fn(async (input: Record<string, unknown>) => { enqueued.push(input); return { id: 'j1' }; }),
  };
  const advanced: string[] = [];
  const pipeline = {
    advance: jest.fn(async (id: string) => { advanced.push(id); return { state: 'verified', ran: [] }; }),
  };
  const profiles = {
    // An explicit `null` means "this profile is gone"; only an absent option
    // falls back to the default. `??` would collapse the two and hide a
    // deleted-profile test behind a profile that still exists.
    get: jest.fn(async () => (opts.profile === undefined ? { id: 'p1', name: 'Default' } : opts.profile)),
    defaultProfile: jest.fn(async () => (opts.profile === undefined ? { id: 'p1', name: 'Default' } : opts.profile)),
  };

  const svc = new IntakeTriggerService(
    prisma as never, bus as never, intake as never, profiles as never, pipeline as never,
    moduleRef as never,
  );
  const logger = (svc as never as { logger: Record<string, (m: string) => void> }).logger;
  jest.spyOn(logger, 'warn').mockImplementation((m: string) => { warnings.push(m); });
  jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
  svc.onModuleInit();
  return { svc, handlers, enqueued, warnings, prisma, intake, pipeline, advanced, consumed };
}

const completion = (over: Record<string, unknown> = {}) => ({
  resourceId: 'hash-1',
  payload: {
    hash: 'hash-1',
    // savePath is the DIRECTORY; contentPath is the torrent's own item. Distinct
    // values here, so a test cannot pass by reading the wrong one.
    savePath: '/staging',
    contentPath: '/staging/Show.S01E01',
    engineId: 'engine-1',
    ...over,
  },
});

/** Deliver the event and let the fire-and-forget handler settle. */
async function fire(handlers: Map<string, Handler>, event: unknown) {
  handlers.get(DOMAIN_EVENTS.TORRENT_COMPLETED)!(event);
  await new Promise((r) => setImmediate(r));
}

const managed = { id: 'rule-1', name: 'Managed rule', importMode: 'managed_intake', storageProfileId: 'p1' };
const legacy = { id: 'rule-1', name: 'Old rule', importMode: 'legacy_direct', storageProfileId: null };

describe('managed intake gate', () => {
  it('subscribes to the existing completion edge rather than polling', () => {
    // Two independent observers of the same condition drift, and the one that
    // drifts is the one that imports twice.
    const { handlers } = build();
    expect(handlers.has(DOMAIN_EVENTS.TORRENT_COMPLETED)).toBe(true);
  });

  it('does NOTHING for a legacy rule', async () => {
    // The upgrade guarantee. Every pre-existing rule reads legacy_direct.
    const { handlers, enqueued } = build({ rule: legacy });
    await fire(handlers, completion());
    expect(enqueued).toHaveLength(0);
  });

  it('does NOTHING for a torrent with no rule behind it', async () => {
    /*
     * A manual add. The operator already chose where it should go when they
     * added it; intercepting would override a decision they made deliberately.
     */
    const { handlers, enqueued } = build({ acquisition: null });
    await fire(handlers, completion());
    expect(enqueued).toHaveLength(0);
  });

  it('does NOTHING when the acquisition names no rule', async () => {
    const { handlers, enqueued } = build({ acquisition: { rssRuleId: null } });
    await fire(handlers, completion());
    expect(enqueued).toHaveLength(0);
  });

  it('enqueues only for a rule explicitly marked managed', async () => {
    const { handlers, enqueued } = build({ rule: managed });
    await fire(handlers, completion());
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ torrentHash: 'hash-1', profileId: 'p1', engineId: 'engine-1' });
  });

  it('falls back to the default profile when the rule names none', async () => {
    const { handlers, enqueued } = build({
      rule: { ...managed, storageProfileId: null },
    });
    await fire(handlers, completion());
    expect(enqueued[0]).toMatchObject({ profileId: 'p1' });
  });

  it('says so when a managed rule has no profile, rather than going quiet', async () => {
    /*
     * "Enabled but inert" has already bitten this project twice — the IMDb
     * schedule and the timezone rollout. A rule marked managed that never
     * imports must not be silent about why.
     */
    const { handlers, enqueued, warnings } = build({
      rule: { ...managed, storageProfileId: null }, profile: null,
    });
    await fire(handlers, completion());
    expect(enqueued).toHaveLength(0);
    expect(warnings.join(' ')).toMatch(/no storage profile is configured/);
  });

  it('does not stage a completion that carries no path', async () => {
    const { handlers, enqueued, warnings } = build({ rule: managed });
    await fire(handlers, completion({ savePath: undefined, contentPath: undefined }));
    expect(enqueued).toHaveLength(0);
    expect(warnings.join(' ')).toMatch(/no path/);
  });

  it('DRIVES the pipeline after enqueueing, not just queues it', async () => {
    /*
     * The gap this closes. Enqueueing is not running: without the advance call
     * every intake sat at `queued` with nothing to move it, which looks exactly
     * like a broken pipeline and was in fact a missing line.
     */
    const { handlers, advanced } = build({ rule: managed });
    await fire(handlers, completion());
    expect(advanced).toEqual(['j1']);
  });

  it('does not advance anything when the gate refused the torrent', async () => {
    const { handlers, advanced } = build({ rule: legacy });
    await fire(handlers, completion());
    expect(advanced).toHaveLength(0);
  });

  it('never lets a pipeline failure disturb torrent bookkeeping', async () => {
    const { handlers, pipeline } = build({ rule: managed });
    pipeline.advance.mockRejectedValue(new Error('disk full') as never);
    await expect(fire(handlers, completion())).resolves.toBeUndefined();
  });

  it('never lets an intake failure disturb torrent bookkeeping', async () => {
    /*
     * The sync loop publishes this event mid-cycle. An exception escaping the
     * handler would stall the loop that tracks every torrent on the install.
     */
    const { handlers, intake } = build({ rule: managed });
    intake.enqueue.mockRejectedValue(new Error('database down') as never);
    await expect(fire(handlers, completion())).resolves.toBeUndefined();
  });

  it('ignores an event with no hash', async () => {
    const { handlers, enqueued } = build({ rule: managed });
    await fire(handlers, { payload: {} });
    expect(enqueued).toHaveLength(0);
  });
});

describe('IntakeTriggerService — missing-episode grabs', () => {
  /*
   * Missing-episode downloads never touch `rss_acquisitions` — they go out through
   * MissingEpisodeSearchService, a separate path entirely. Before this they were
   * invisible to intake, so a rule converted to managed intake staged its
   * missing-episode grabs into a directory nothing would ever import from.
   */
  it('picks up a grab traced by the wanted episode when there is no acquisition', async () => {
    const { handlers, enqueued } = build({
      acquisition: null,
      wanted: { intakeRuleId: 'rule-1' },
      rule: { id: 'rule-1', name: 'Ghosts', importMode: 'managed_intake', storageProfileId: 'p1' },
    });
    await handlers.get(DOMAIN_EVENTS.TORRENT_COMPLETED)!(completion());
    await new Promise((r) => setImmediate(r));
    expect(enqueued).toHaveLength(1);
  });

  it('ignores a grab whose wanted episode recorded no rule', async () => {
    // Null intakeRuleId means it went straight to the library — the legacy path,
    // which intake must not touch or it would import the same file twice.
    const { handlers, enqueued } = build({ acquisition: null, wanted: { intakeRuleId: null } });
    await handlers.get(DOMAIN_EVENTS.TORRENT_COMPLETED)!(completion());
    await new Promise((r) => setImmediate(r));
    expect(enqueued).toHaveLength(0);
  });

  it('ignores a torrent with neither trace', async () => {
    // A hand-added torrent. Nobody asked intake to place it.
    const { handlers, enqueued } = build({ acquisition: null, wanted: null });
    await handlers.get(DOMAIN_EVENTS.TORRENT_COMPLETED)!(completion());
    await new Promise((r) => setImmediate(r));
    expect(enqueued).toHaveLength(0);
  });

  it('still honours legacy_direct on a missing-episode grab', async () => {
    const { handlers, enqueued } = build({
      acquisition: null,
      wanted: { intakeRuleId: 'rule-1' },
      rule: { id: 'rule-1', name: 'Ghosts', importMode: 'legacy_direct', storageProfileId: null },
    });
    await handlers.get(DOMAIN_EVENTS.TORRENT_COMPLETED)!(completion());
    await new Promise((r) => setImmediate(r));
    expect(enqueued).toHaveLength(0);
  });
});

describe('IntakeTriggerService — which path it imports from', () => {
  /*
   * `savePath` is the directory a torrent was saved INTO and is shared: ten
   * episodes of one show report the same one, and a movie feed's whole catalogue
   * reports a directory that on a live install held 3,305 entries. Importing from
   * it means importing everything in it rather than the release that finished.
   */
  it('prefers the torrent’s OWN path over the directory it landed in', async () => {
    const { handlers, enqueued } = build({
      rule: { id: 'rule-1', name: 'R', importMode: 'managed_intake', storageProfileId: 'p1' },
    });
    await handlers.get(DOMAIN_EVENTS.TORRENT_COMPLETED)!(completion());
    await new Promise((r) => setImmediate(r));
    expect(enqueued[0].sourcePath).toBe('/staging/Show.S01E01');
  });

  it('falls back to the save path when the engine cannot report the item', async () => {
    // rTorrent may not answer d.base_path; degrading to today's behaviour beats
    // refusing the import outright.
    const { handlers, enqueued } = build({
      rule: { id: 'rule-1', name: 'R', importMode: 'managed_intake', storageProfileId: 'p1' },
    });
    await handlers.get(DOMAIN_EVENTS.TORRENT_COMPLETED)!(completion({ contentPath: undefined }));
    await new Promise((r) => setImmediate(r));
    expect(enqueued[0].sourcePath).toBe('/staging');
  });

  it('ignores an empty contentPath rather than staging nothing', async () => {
    // An empty string is what a provider reports when it has no answer; treating
    // it as a path would enqueue a job with a blank source.
    const { handlers, enqueued } = build({
      rule: { id: 'rule-1', name: 'R', importMode: 'managed_intake', storageProfileId: 'p1' },
    });
    await handlers.get(DOMAIN_EVENTS.TORRENT_COMPLETED)!(completion({ contentPath: '' }));
    await new Promise((r) => setImmediate(r));
    expect(enqueued[0].sourcePath).toBe('/staging');
  });
});

/**
 * The third provenance source: a decision the operator made in the Add Torrent
 * dialog, recorded against the hash.
 *
 * The rule gate above protects installs that never opted in. An intent IS the
 * opt-in, for exactly one torrent, so it must not be filtered by a rule setting
 * the operator never touched — and it must not leak into the rule path, or a
 * plain manual add starts being intercepted.
 */
describe('manual intake intent', () => {
  const intent = { engineId: 'engine-1', profileId: 'p1' };

  it('stages a hand-added torrent that has no rule at all', async () => {
    const { handlers, enqueued } = build({ acquisition: null, intent });
    await fire(handlers, completion());
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      torrentHash: 'hash-1',
      profileId: 'p1',
      sourcePath: '/staging/Show.S01E01',
    });
  });

  it('does not consult importMode — an explicit choice is its own opt-in', async () => {
    // A legacy rule would refuse this torrent. The intent outranks it: the
    // operator chose managed intake for THIS download.
    const { handlers, enqueued } = build({ rule: legacy, intent });
    await fire(handlers, completion());
    expect(enqueued).toHaveLength(1);
  });

  it('spends the intent so a re-observed edge cannot import twice', async () => {
    const { handlers, consumed } = build({ acquisition: null, intent });
    await fire(handlers, completion());
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({
      where: { engineId: 'engine-1', hash: 'hash-1', consumedAt: null },
    });
  });

  it('leaves an ordinary manual add alone', async () => {
    // No intent, no rule: the operator chose where it goes. This is the
    // behaviour every pre-existing install depends on.
    const { handlers, enqueued } = build({ acquisition: null, intent: null });
    await fire(handlers, completion());
    expect(enqueued).toHaveLength(0);
  });

  it('says so when the profile behind an intent has been deleted', async () => {
    const { handlers, enqueued, warnings } = build({
      acquisition: null,
      intent,
      profile: null,
    });
    await fire(handlers, completion());
    expect(enqueued).toHaveLength(0);
    expect(warnings.join(' ')).toContain('storage profile is gone');
  });
});

/**
 * The sweeper exists for one case the completion edge cannot cover: a torrent
 * whose data is already on disk never crosses 0→100%, so `torrent.completed` is
 * never published for it and the intent would wait forever.
 */
describe('intent sweep', () => {
  const pending = [{ hash: 'hash-9', engineId: 'engine-1', profileId: 'p1' }];

  it('stages an intent whose torrent is already complete', async () => {
    const { svc, enqueued } = build({
      pendingIntents: pending,
      engineTorrents: [
        { hash: 'hash-9', progress: 1, contentPath: '/staging/Old.Release', savePath: '/staging' },
      ],
    });
    await expect(svc.sweepIntents()).resolves.toBe(1);
    expect(enqueued[0]).toMatchObject({
      torrentHash: 'hash-9',
      profileId: 'p1',
      sourcePath: '/staging/Old.Release',
    });
  });

  it('leaves a download still in flight alone', async () => {
    const { svc, enqueued } = build({
      pendingIntents: pending,
      engineTorrents: [{ hash: 'hash-9', progress: 0.42, savePath: '/staging' }],
    });
    await expect(svc.sweepIntents()).resolves.toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it('does nothing when the engine cannot be read', async () => {
    /*
     * An unreachable engine looks exactly like a torrent that has not finished.
     * Acting on the ambiguity would stage every pending intent from nothing.
     */
    const { svc, enqueued } = build({ pendingIntents: pending, engineTorrents: null });
    await expect(svc.sweepIntents()).resolves.toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it('matches the engine’s hash case-insensitively', async () => {
    // Engines disagree on hash case; a case-sensitive miss would look exactly
    // like "the download never finished" and strand the intake silently.
    const { svc, enqueued } = build({
      pendingIntents: [{ hash: 'HASH-9', engineId: 'engine-1', profileId: 'p1' }],
      engineTorrents: [{ hash: 'hash-9', progress: 1, contentPath: '/staging/Old.Release' }],
    });
    await expect(svc.sweepIntents()).resolves.toBe(1);
    expect(enqueued).toHaveLength(1);
  });
});
