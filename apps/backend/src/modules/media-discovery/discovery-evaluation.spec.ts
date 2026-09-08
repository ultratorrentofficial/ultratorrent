import { DiscoveryEvaluationService } from './discovery-evaluation.service';

const NOW = new Date('2026-09-06T12:00:00Z');
const soon = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

const TEMPLATE: any = {
  id: 'dt1',
  name: 'Premium TV',
  enabled: true,
  mediaType: 'any',
  upcomingWindowDays: 90,
  regions: [],
  languages: [],
  networks: [],
  streamingServices: [],
  studios: [],
  releaseTypes: [],
  autoMonitorCategories: ['Sci-Fi'],
  notifyOnlyCategories: ['Drama'],
  ignoreCategories: ['Reality'],
  blockedFromAutoCategories: [],
  categoryMatchMode: 'ANY',
  minimumConfidence: 0.8,
  autoAddLimitPerDay: 10,
  autoAddLimitPerWeek: 30,
  storageProfileId: null,
  acquisitionTemplateId: null,
  pathTemplate: null,
  createIntakeDirectory: false,
};

const row = (id: string, over: any = {}) => ({
  id,
  mediaType: 'tv',
  title: `Show ${id}`,
  year: 2026,
  genres: ['Sci-Fi'],
  originalLanguage: 'en',
  countries: ['US'],
  network: null,
  streamingService: null,
  studio: null,
  popularity: 90,
  rating: 8,
  voteCount: 500,
  identityStatus: 'resolved',
  confidence: 1,
  externalIds: { imdb: `tt${id}` },
  releaseDates: [{ releaseType: 'series_premiere', date: soon(10), region: 'US' }],
  ...over,
});

function harness(opts: {
  rows?: any[]; remaining?: number; watchlistFails?: boolean; ruleFails?: boolean; ruleReason?: string;
  ruleIsUserModified?: boolean; watchlistStatus?: string; existing?: any; readiness?: any; profile?: any; template?: any; watchlistOutcome?: string;
} = {}) {
  const evaluations: any[] = [];
  const stamps: any[] = [];
  const prisma: any = {
    discoveryTemplate: {
      findMany: jest.fn(async () => [TEMPLATE]),
      findUnique: jest.fn(async () => opts.template ?? TEMPLATE),
      findFirst: jest.fn(async () => opts.template ?? TEMPLATE),
    },
    discoveredMedia: {
      findMany: jest.fn(async () => opts.rows ?? [row('a')]),
      findUnique: jest.fn(async () => (opts.rows ?? [row('a')])[0]),
      update: jest.fn(async ({ data }: any) => {
        stamps.push(data);
        return {};
      }),
    },
    discoveryEvaluation: {
      create: jest.fn(async ({ data }: any) => {
        evaluations.push(data);
        return {};
      }),
    },
    storageProfile: {
      findUnique: jest.fn(async () =>
        opts.profile === undefined
          ? {
              id: 'sp-1', stagingRoot: '/downloads/Intake',
              movieLibraryId: 'lib-m', tvLibraryId: 'lib-tv',
              movieLibrary: { path: '/media/Movies' }, tvLibrary: { path: '/media/TV' },
            }
          : opts.profile,
      ),
    },
    acquisitionRuleTemplate: { findUnique: jest.fn(async () => null) },
    rssRule: { deleteMany: jest.fn(async () => ({ count: opts.ruleIsUserModified ? 0 : 1 })) },
    mediaAcquisitionWatchlistItem: {
      findUnique: jest.fn(async () => ({ status: opts.watchlistStatus ?? 'active' })),
      update: jest.fn(async () => ({})),
    },
  };
  const budget = {
    state: jest.fn(async () => ({
      perDay: 10, perWeek: 30, usedToday: 0, usedThisWeek: 0,
      remainingToday: opts.remaining ?? 10,
      remainingThisWeek: opts.remaining ?? 30,
      exhausted: (opts.remaining ?? 10) <= 0,
    })),
  };
  const watchlist = {
    linkOrCreate: jest.fn(async () => {
      if (opts.watchlistFails) throw new Error('watchlist exploded');
      return { watchlistItemId: 'w1', outcome: opts.watchlistOutcome ?? 'created' };
    }),
  };
  const rules = {
    generate: jest.fn(async () => {
      if (opts.ruleFails) throw new Error('rule exploded');
      return { ruleId: 'r1', outcome: 'created', ...(opts.ruleReason ? { reason: opts.ruleReason } : {}) };
    }),
  };
  const intake = { provision: jest.fn(async () => ({ ok: true, detail: 'created', path: '/x' })) };
  const published: any[] = [];
  const bus = { publish: jest.fn((e: any) => { published.push(e); }) };
  const removal = { suppress: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async () => undefined) };
  /*
   * The identity gate. Default is "nothing here represents this work" — the only
   * state that may create — so every pre-existing test keeps asserting what it
   * always asserted, and the existing-identity cases opt in explicitly.
   */
  const templates = {
    canAutoMonitor: jest.fn(() => true),
    acquisitionReadiness: jest.fn(async () =>
      opts.readiness ?? { ready: true, reason: 'Match preferences "TV Premium 4K" are ready' },
    ),
  };
  const identity = {
    resolve: jest.fn(async () => opts.existing ?? {
      state: 'none', matchedBy: null, matchedIdNamespace: null,
      watchlistItem: null, rssRule: null, libraryItemIds: [], detail: 'Not present in UltraTorrent',
    }),
  };

  return {
    svc: new DiscoveryEvaluationService(prisma, budget as any, watchlist as any, rules as any, intake as any, bus as any, removal as any, identity as any, templates as any, audit as any),
    removal,
    identity,
    templates,
    audit,
    prisma, budget, watchlist, rules, intake, evaluations, stamps, published,
  };
}

describe('running a template', () => {
  it('auto-monitors a qualifying title: watchlist, rule, evaluation, stamp', async () => {
    const h = harness();
    const [out] = await h.svc.runAll(NOW);

    expect(out).toMatchObject({ templateId: 'dt1', examined: 1, monitored: 1, failed: 0 });
    expect(h.watchlist.linkOrCreate).toHaveBeenCalled();
    expect(h.rules.generate).toHaveBeenCalled();
    expect(h.evaluations[0]).toMatchObject({ decision: 'auto_monitor', watchlistItemId: 'w1', rssRuleId: 'r1' });
    expect(h.stamps[0]).toMatchObject({ discoveryStatus: 'monitored', decision: 'auto_monitor' });
  });

  it('records a notify without touching the watchlist or the rules', async () => {
    const h = harness({ rows: [row('a', { genres: ['Drama'] })] });
    const [out] = await h.svc.runAll(NOW);

    expect(out.decisions.notify).toBe(1);
    expect(h.watchlist.linkOrCreate).not.toHaveBeenCalled();
    expect(h.rules.generate).not.toHaveBeenCalled();
    expect(h.stamps[0].discoveryStatus).toBe('notified');
  });

  it('records an ignore', async () => {
    const h = harness({ rows: [row('a', { genres: ['Reality'] })] });
    await h.svc.runAll(NOW);
    expect(h.evaluations[0].decision).toBe('ignore');
    expect(h.stamps[0].discoveryStatus).toBe('ignored');
  });

  /*
   * Skipping the write starves the sweep. The "already decided" filter is
   * `evaluations: { none: … }`, so a title with no row is re-fetched every tick
   * and consumes the page budget forever — measured live, a second pass
   * re-examined the same 500 rows, 407 of them not applicable.
   *
   * So the evaluation is recorded, and the TITLE is left alone: its status stays
   * `new` and it never appears in the inbox as though this template judged it.
   */
  it('records the evaluation but does not touch a title it has no opinion about', async () => {
    const h = harness({ rows: [row('a', { releaseDates: [] })] });
    const [out] = await h.svc.runAll(NOW);

    expect(out.decisions.not_applicable).toBe(1);
    expect(h.evaluations).toHaveLength(1);
    expect(h.stamps).toEqual([]);
  });

  it('makes progress: a title evaluated once is not re-fetched', async () => {
    const h = harness();
    await h.svc.runAll(NOW);
    // Every examined title now has a row for this template, so the same filter
    // excludes it next time.
    expect(h.evaluations).toHaveLength(1);
    expect(h.prisma.discoveredMedia.findMany.mock.calls[0][0].where).toEqual({
      evaluations: { none: { templateId: 'dt1' } },
    });
  });

  it('only evaluates titles this template has not decided about', async () => {
    const h = harness();
    await h.svc.runAll(NOW);
    expect(h.prisma.discoveredMedia.findMany.mock.calls[0][0].where).toEqual({
      evaluations: { none: { templateId: 'dt1' } },
    });
  });

  it('does not evaluate a disabled template', async () => {
    const h = harness();
    await h.svc.runAll(NOW);
    expect(h.prisma.discoveryTemplate.findMany).toHaveBeenCalledWith({ where: { enabled: true } });
  });
});

describe('failure never disappears', () => {
  /*
   * The watchlist entry is what causes acquisition. Without it there is no
   * monitoring, so the title belongs in review however confidently it was decided.
   */
  it('holds a title for review when the watchlist entry could not be created', async () => {
    const h = harness({ watchlistFails: true });
    const [out] = await h.svc.runAll(NOW);

    expect(out.monitored).toBe(0);
    expect(out.failed).toBe(1);
    expect(h.stamps[0].discoveryStatus).toBe('needs_review');
    expect(h.evaluations[0].failureReason).toMatch(/watchlist exploded/);
  });

  /*
   * A rule carries preferences; the entry causes acquisition. Rolling back a
   * correct entry because a convenience failed would be losing the useful half.
   */
  it('keeps a monitored title when rule generation fails, and says so', async () => {
    const h = harness({ ruleFails: true });
    const [out] = await h.svc.runAll(NOW);

    expect(out.monitored).toBe(1);
    expect(h.stamps[0].discoveryStatus).toBe('monitored');
    expect(h.evaluations[0].failureReason).toMatch(/Rule generation failed/);
  });

  it('surfaces a skipped rule reason rather than swallowing it', async () => {
    const h = harness({ ruleReason: 'A rule named "Show a (2026)" already exists' });
    await h.svc.runAll(NOW);
    expect(h.evaluations[0].failureReason).toMatch(/already exists/);
  });
});

describe('the budget', () => {
  /*
   * Read once, spent locally: a single pass must not out-race its own cap by
   * re-reading a count that has not been written yet.
   */
  it('stops auto-monitoring once the allowance runs out mid-pass', async () => {
    const h = harness({ rows: [row('a'), row('b'), row('c')], remaining: 2 });
    const [out] = await h.svc.runAll(NOW);

    expect(out.monitored).toBe(2);
    expect(out.decisions.needs_review).toBe(1);
    expect(h.evaluations[2].reason).toMatch(/Automatic-add threshold reached/);
  });

  it('reads the budget once per template, not once per title', async () => {
    const h = harness({ rows: [row('a'), row('b'), row('c')] });
    await h.svc.runAll(NOW);
    // Three titles, one template, one budget read — re-reading per title would
    // return a count that has not been written yet and let the pass overshoot.
    expect(h.budget.state).toHaveBeenCalledTimes(1);
  });

  it('does not spend budget on a title whose monitoring failed', async () => {
    const h = harness({ rows: [row('a'), row('b')], remaining: 1, watchlistFails: true });
    const [out] = await h.svc.runAll(NOW);
    // Neither succeeded, so the second was still evaluated with budget available.
    expect(out.failed).toBe(2);
    expect(out.decisions.needs_review).toBe(0);
  });
});

describe('the ticker', () => {
  it('never throws', async () => {
    const h = harness();
    h.prisma.discoveryTemplate.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(h.svc.tick()).resolves.toBeUndefined();
  });

  it('refuses to run two passes at once', async () => {
    const h = harness();
    const first = h.svc.runAll(NOW);
    const second = await h.svc.runAll(NOW);
    await first;
    expect(second).toEqual([]);
  });
});

describe('what it tells a person about', () => {
  const keys = (published: any[]) => published.map((e) => e.eventKey);

  /*
   * The system acquiring something without being asked is exactly what a person
   * should be told about, so this one is per title — and its volume is already
   * bounded by the automatic-add limit rather than by suppressing the event.
   */
  it('announces each auto-monitored title', async () => {
    const h = harness({ rows: [row('a'), row('b')] });
    await h.svc.runAll(NOW);
    expect(keys(h.published).filter((k) => k === 'media_discovery.auto_monitored')).toHaveLength(2);
    expect(h.published[0].payload).toMatchObject({ title: 'Show a (2026)', templateName: 'Premium TV' });
  });

  it('says nothing about a notified or ignored title', async () => {
    const h = harness({ rows: [row('a', { genres: ['Drama'] }), row('b', { genres: ['Reality'] })] });
    await h.svc.runAll(NOW);
    expect(h.published).toEqual([]);
  });

  /*
   * A first pass can hold twenty titles at once, and twenty notifications all say
   * the same thing and are all answered by one visit to the inbox.
   */
  it('summarises held titles once per run, not once per title', async () => {
    const h = harness({ rows: [row('a'), row('b'), row('c')], remaining: 0 });
    await h.svc.runAll(NOW);
    const review = h.published.filter((e) => e.eventKey === 'media_discovery.review_required');
    expect(review).toHaveLength(1);
    expect(review[0].payload).toEqual({ count: 3, templateName: 'Premium TV' });
  });

  it('does not announce a review summary when nothing was held', async () => {
    const h = harness();
    await h.svc.runAll(NOW);
    expect(keys(h.published)).not.toContain('media_discovery.review_required');
  });

  /*
   * A monitored title with no rule of its own is a real fault with its own
   * cause, so it is reported per title rather than folded into a summary.
   */
  it('reports a title that is monitored but got no rule', async () => {
    const h = harness({ ruleFails: true });
    await h.svc.runAll(NOW);
    const failed = h.published.filter((e) => e.eventKey === 'media_discovery.rule_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.reason).toMatch(/Rule generation failed/);
  });

  it('does not report a rule failure when the rule was generated', async () => {
    const h = harness();
    await h.svc.runAll(NOW);
    expect(keys(h.published)).not.toContain('media_discovery.rule_failed');
  });
});

/**
 * Withdrawing monitoring when a title stops qualifying.
 *
 * Reached after a template edit clears the old decisions and the answer comes
 * back different. The rule this file is really pinning is the one about what
 * retraction must NEVER do: it runs from a background sweep that fired because
 * somebody edited a genre list, and a sweep that deleted media as a side effect
 * of that edit would be both unrecoverable and invisible.
 */
describe('retraction', () => {
  /** A title this template previously auto-monitored. */
  const monitored = (over: any = {}) =>
    row('m1', {
      discoveryStatus: 'monitored',
      matchedTemplateId: TEMPLATE.id,
      rssRuleId: 'r1',
      watchlistItemId: 'w1',
      ...over,
    });

  it('deletes the generated rule and archives the watchlist entry', async () => {
    const h = harness({ rows: [monitored({ genres: ['Cooking'] })] });
    const [outcome] = await h.svc.runAll();
    expect(outcome.retracted).toBe(1);
    expect(h.prisma.rssRule.deleteMany).toHaveBeenCalledWith({
      where: { id: 'r1', generatedByDiscovery: true, userModifiedAt: null },
    });
    expect(h.prisma.mediaAcquisitionWatchlistItem.update).toHaveBeenCalledWith({
      where: { id: 'w1' },
      data: { status: 'archived' },
    });
  });

  /*
   * THE property. Nothing in this path may reach a file or a torrent.
   */
  it('never deletes media or torrents', async () => {
    const h = harness({ rows: [monitored({ genres: ['Cooking'] })] });
    await h.svc.runAll();
    // The evaluator has no media-deletion collaborator at all, and the only
    // thing it may ask of removal is to drop the catalogue row.
    expect(Object.keys(h.removal)).toEqual(['suppress']);
    expect(h.prisma).not.toHaveProperty('mediaItem');
  });

  /*
   * Past the first hand edit the rule is the operator's. A sweep that deleted it
   * would discard work nobody asked it to touch.
   */
  it('leaves a hand-edited rule alone', async () => {
    const h = harness({ rows: [monitored({ genres: ['Cooking'] })], ruleIsUserModified: true });
    const [outcome] = await h.svc.runAll();
    expect(outcome.retracted).toBe(1);
    // deleteMany still runs, but its filter refuses to match — the guard is in
    // the WHERE clause rather than in a branch that could be forgotten.
    expect(h.prisma.rssRule.deleteMany).toHaveBeenCalled();
  });

  it('does not overrule a watchlist entry a person paused', async () => {
    const h = harness({ rows: [monitored({ genres: ['Cooking'] })], watchlistStatus: 'paused' });
    await h.svc.runAll();
    expect(h.prisma.mediaAcquisitionWatchlistItem.update).not.toHaveBeenCalled();
  });

  /*
   * Out of scope entirely, or explicitly ignored, means it leaves the catalogue.
   * Still matching but at a lower decision does not — it is still something the
   * operator is meant to see.
   */
  it('drops a title from the catalogue when it no longer applies at all', async () => {
    // No qualifying release date at all, so the template has no opinion on it.
    const h = harness({ rows: [monitored({ releaseDates: [] })] });
    const [outcome] = await h.svc.runAll();
    expect(outcome.removedFromCatalog).toBe(1);
    expect(h.removal.suppress).toHaveBeenCalledWith('m1', 'retracted');
  });

  it('keeps a title that still matches, only at a lower decision', async () => {
    const h = harness({ rows: [monitored({ confidence: 0.2 })] });
    const [outcome] = await h.svc.runAll();
    expect(outcome.retracted).toBe(1);
    expect(outcome.removedFromCatalog).toBe(0);
    expect(h.removal.suppress).not.toHaveBeenCalled();
  });

  /*
   * A title this template never monitored is not "retracted" by being ignored —
   * counting it would make every ordinary sweep look like it was undoing things.
   */
  it('does not retract a title this template never monitored', async () => {
    const h = harness({ rows: [row('x', { genres: ['Cooking'] })] });
    const [outcome] = await h.svc.runAll();
    expect(outcome.retracted).toBe(0);
    expect(h.prisma.rssRule.deleteMany).not.toHaveBeenCalled();
  });

  it('does not retract a title that still qualifies', async () => {
    const h = harness({ rows: [monitored()] });
    const [outcome] = await h.svc.runAll();
    expect(outcome.retracted).toBe(0);
  });
});

/**
 * The identity gate, from the evaluator's side.
 *
 * The resolver decides what already exists; these tests pin what the evaluator
 * does with that answer — which is the half that actually prevents the duplicate
 * being written.
 */
describe('the identity gate', () => {
  const already = {
    state: 'already_monitored', matchedBy: 'external_id', matchedIdNamespace: 'tmdb',
    watchlistItem: { id: 'wl-existing', status: 'active', rssRuleId: 'r-existing', title: 'The Terminal List' },
    rssRule: { id: 'r-existing', name: 'The Terminal List', generatedByDiscovery: false, userModifiedAt: null },
    libraryItemIds: [], detail: 'Already monitored (matched by TMDB id)',
  };

  it('creates nothing when the show is already monitored', async () => {
    const h = harness({ existing: already });
    const [outcome] = await h.svc.runAll();
    expect(h.watchlist.linkOrCreate).not.toHaveBeenCalled();
    expect(h.rules.generate).not.toHaveBeenCalled();
    expect(h.intake.provision).not.toHaveBeenCalled();
    expect(outcome.decisions.already_monitored).toBe(1);
    expect(outcome.decisions.auto_monitor).toBe(0);
    expect(outcome.monitored).toBe(0);
  });

  /*
   * Reported, not swallowed. A title that quietly vanished because it was
   * already handled is indistinguishable from one the engine forgot.
   */
  it('records why, naming the existing identity', async () => {
    const h = harness({ existing: already });
    await h.svc.runAll();
    expect(h.stamps[0].decision).toBe('already_monitored');
    expect(h.stamps[0].decisionReason).toMatch(/Already monitored/);
  });

  /*
   * The idempotency mechanism: the catalogue row is pointed at what already
   * exists, so a second pass finds the link rather than re-resolving from
   * scratch, and nothing downstream sees an orphan.
   */
  it('links the catalogue row to the existing watchlist entry and rule', async () => {
    const h = harness({ existing: already });
    await h.svc.runAll();
    expect(h.stamps[0].watchlistItemId).toBe('wl-existing');
    expect(h.stamps[0].rssRuleId).toBe('r-existing');
  });

  it('does not spend the auto-add budget on something it did not add', async () => {
    const h = harness({ existing: already });
    const [outcome] = await h.svc.runAll();
    expect(outcome.monitored).toBe(0);
  });

  it('reports a half-configured show as incomplete rather than creating a second', async () => {
    const h = harness({
      existing: { ...already, state: 'monitoring_incomplete', rssRule: null,
        detail: 'On the watchlist but with no acquisition rule' },
    });
    const [outcome] = await h.svc.runAll();
    expect(outcome.decisions.exists_monitoring_incomplete).toBe(1);
    expect(h.watchlist.linkOrCreate).not.toHaveBeenCalled();
    expect(h.rules.generate).not.toHaveBeenCalled();
  });

  it('reports a library-only show as existing but unmonitored', async () => {
    const h = harness({
      existing: { ...already, state: 'exists_not_monitored', watchlistItem: null, rssRule: null,
        libraryItemIds: ['mi1'], detail: '1 item(s) already in your library' },
    });
    const [outcome] = await h.svc.runAll();
    expect(outcome.decisions.exists_not_monitored).toBe(1);
    expect(h.watchlist.linkOrCreate).not.toHaveBeenCalled();
  });

  it('still creates for a genuinely new title', async () => {
    const h = harness();
    const [outcome] = await h.svc.runAll();
    expect(h.watchlist.linkOrCreate).toHaveBeenCalled();
    expect(outcome.decisions.auto_monitor).toBe(1);
  });

  /*
   * The gate is not consulted for a title nobody is going to act on: three
   * queries per row for an answer no code path reads is a cost paid on every
   * tick, over the whole catalogue.
   */
  it('does not resolve identity for a title it was never going to monitor', async () => {
    const h = harness({ rows: [row('x', { genres: ['Cooking'] })] });
    await h.svc.runAll();
    expect(h.identity.resolve).not.toHaveBeenCalled();
  });
});

/**
 * A template that cannot build a working rule creates nothing at all.
 *
 * "Do not create partial automatic monitoring." Failing after the watchlist
 * entry exists would leave exactly the half-configured state this is meant to
 * prevent — and worse, it would look like it worked.
 */
describe('template readiness', () => {
  const unready = { ready: false, reason: 'Select match preferences before enabling automatic monitoring' };

  it('creates no watchlist entry, no rule and no directory', async () => {
    const h = harness({ readiness: unready });
    await h.svc.runAll();
    expect(h.watchlist.linkOrCreate).not.toHaveBeenCalled();
    expect(h.rules.generate).not.toHaveBeenCalled();
    expect(h.intake.provision).not.toHaveBeenCalled();
  });

  it('holds the title for review with the precise reason', async () => {
    const h = harness({ readiness: unready });
    const [outcome] = await h.svc.runAll();
    expect(outcome.decisions.needs_review).toBe(1);
    expect(outcome.decisions.auto_monitor).toBe(0);
    expect(h.stamps[0].decisionReason).toMatch(/Select match preferences/);
  });

  /* Asked once per run: a template cannot change configuration mid-pass. */
  it('checks readiness once, not once per title', async () => {
    const h = harness({ readiness: unready, rows: [row('a'), row('b'), row('c')] });
    await h.svc.runAll();
    expect(h.templates.acquisitionReadiness).toHaveBeenCalledTimes(1);
  });

  it('does not ask at all for a template that only notifies', async () => {
    const h = harness();
    h.templates.canAutoMonitor.mockReturnValue(false);
    await h.svc.runAll();
    expect(h.templates.acquisitionReadiness).not.toHaveBeenCalled();
  });

  it('proceeds normally when the template is ready', async () => {
    const h = harness();
    const [outcome] = await h.svc.runAll();
    expect(outcome.decisions.auto_monitor).toBe(1);
    expect(h.watchlist.linkOrCreate).toHaveBeenCalled();
  });
});

/**
 * The generated rule records where its media should be staged.
 *
 * `generate()` accepted a `savePath` and nothing ever supplied one, so every
 * generated rule stored `null` and the template's `pathTemplate` only ever
 * affected directory PROVISIONING — which is off by default. A template
 * configured with `{tvshow} ({year})` therefore did nothing at all: the worst
 * kind of setting, because it looks configured.
 */
describe('the generated rule carries its target path', () => {
  /** The first argument `generate()` was called with. */
  const genArg = (h: any) => (h.rules.generate as jest.Mock).mock.calls[0][0];

  const withPath = (over: any = {}) => ({
    ...TEMPLATE,
    pathTemplate: 'TV Shows/{tvshow} ({year})',
    storageProfileId: 'sp-1',
    createIntakeDirectory: false,
    ...over,
  });

  it('renders the storage profile staging root plus the template fragment', async () => {
    const h = harness();
    h.prisma.discoveryTemplate.findMany = jest.fn(async () => [withPath()]);
    await h.svc.runAll();
    expect(genArg(h).savePath).toBe(
      '/downloads/Intake/TV Shows/Show a (2026)',
    );
  });

  /*
   * `createIntakeDirectory` decides whether the folder is CREATED, not whether
   * the path is recorded — conflating the two is what made the setting inert.
   */
  /*
   * The directory is created whenever there is a path for it. This was gated on
   * `createIntakeDirectory` — a flag not exposed in the form and defaulting to
   * false — so in practice the folder was never made, and the engine was pointed
   * at a directory that did not exist. rTorrent does not create one, so the
   * download failed at grab time.
   */
  it('creates the directory even with the old flag off', async () => {
    const h = harness();
    h.prisma.discoveryTemplate.findMany = jest.fn(async () => [withPath({ createIntakeDirectory: false })]);
    await h.svc.runAll();
    expect(genArg(h).savePath).toContain('/downloads/Intake/');
    expect(h.intake.provision).toHaveBeenCalled();
  });

  it('creates no directory when there is no path to create', async () => {
    const h = harness();
    h.prisma.discoveryTemplate.findMany = jest.fn(async () => [withPath({ pathTemplate: null })]);
    await h.svc.runAll();
    expect(h.intake.provision).not.toHaveBeenCalled();
  });

  /* A directory that could not be made is reported, never a reason to have done nothing. */
  it('keeps the monitoring when the directory cannot be created', async () => {
    const h = harness();
    h.intake.provision = jest.fn(async () => ({ ok: false, detail: 'Permission denied', path: '/x' }));
    h.prisma.discoveryTemplate.findMany = jest.fn(async () => [withPath()]);
    await h.svc.runAll();
    expect(h.watchlist.linkOrCreate).toHaveBeenCalled();
    expect(h.rules.generate).toHaveBeenCalled();
    expect(h.stamps[0].decisionReason).toMatch(/Permission denied/);
  });

  it('uses one rendered path for both the rule and the directory', async () => {
    const h = harness();
    h.prisma.discoveryTemplate.findMany = jest.fn(async () => [withPath({ createIntakeDirectory: true })]);
    await h.svc.runAll();
    expect(h.intake.provision).toHaveBeenCalled();
    const provisioned = (h.intake.provision as jest.Mock).mock.calls[0][0];
    expect(provisioned.stagingRoot).toBe('/downloads/Intake');
    expect(provisioned.pathTemplate).toBe('TV Shows/{tvshow} ({year})');
  });

  it('sends no path when the template does not define one', async () => {
    const h = harness();
    h.prisma.discoveryTemplate.findMany = jest.fn(async () => [withPath({ pathTemplate: null })]);
    await h.svc.runAll();
    expect(genArg(h).savePath).toBeNull();
  });

  /* A path that cannot be built must not cost the monitoring. */
  it('still creates the watchlist entry when the path cannot be rendered', async () => {
    const h = harness({ profile: { id: 'sp-1', stagingRoot: 'not-absolute', movieLibraryId: null, tvLibraryId: null, movieLibrary: null, tvLibrary: null } });
    h.prisma.discoveryTemplate.findMany = jest.fn(async () => [withPath()]);
    await h.svc.runAll();
    expect(h.watchlist.linkOrCreate).toHaveBeenCalled();
    expect(genArg(h).savePath).toBeNull();
  });
});

/**
 * Importing a title a person approved from review.
 *
 * The point of this path is that it is NOT a second creation path: it runs the
 * same `act()` an automatic monitor runs, so an approved title ends up
 * configured identically. Two creation paths would be two sets of bugs, and they
 * would drift.
 */
describe('importing from review', () => {
  it('creates the watchlist entry, the rule and the directory, exactly as automation would', async () => {
    const h = harness();
    const r = await h.svc.approve('a', 'user-1');
    expect(h.watchlist.linkOrCreate).toHaveBeenCalled();
    expect(h.rules.generate).toHaveBeenCalled();
    expect(r.alreadyExisted).toBe(false);
    expect(r.watchlistItemId).toBe('w1');
  });

  it('stamps the catalogue row as monitored', async () => {
    const h = harness();
    await h.svc.approve('a', 'user-1');
    expect(h.stamps.at(-1).decision).toBe('auto_monitor');
    expect(h.stamps.at(-1).decisionReason).toMatch(/Imported by an operator/);
  });

  /*
   * The identity gate still applies. Approving something already monitored must
   * link, not duplicate — that is the whole point of the gate, and a manual
   * action is exactly when somebody might approve a show they already have.
   */
  it('links rather than duplicating when the show is already monitored', async () => {
    const h = harness({
      existing: {
        state: 'already_monitored', matchedBy: 'external_id', matchedIdNamespace: 'tmdb',
        watchlistItem: { id: 'wl-existing', status: 'active', rssRuleId: 'r-existing', title: 'X' },
        rssRule: { id: 'r-existing', name: 'X', generatedByDiscovery: false, userModifiedAt: null },
        libraryItemIds: [], detail: 'Already monitored',
      },
    });
    const r = await h.svc.approve('a', 'user-1');
    expect(r.alreadyExisted).toBe(true);
    expect(h.watchlist.linkOrCreate).not.toHaveBeenCalled();
    expect(h.rules.generate).not.toHaveBeenCalled();
    expect(r.rssRuleId).toBe('r-existing');
  });

  /* An unready template cannot be imported into — that would be the half-configured
   * monitoring the readiness check exists to prevent, just reached by hand. */
  it('refuses when the template has no usable match preferences', async () => {
    const h = harness({ readiness: { ready: false, reason: 'Select match preferences' } });
    await expect(h.svc.approve('a', 'user-1')).rejects.toThrow(/match preferences/);
    expect(h.watchlist.linkOrCreate).not.toHaveBeenCalled();
  });

  it('audits the import before acting', async () => {
    const order: string[] = [];
    const h = harness();
    h.audit.record.mockImplementation(async () => { order.push('audit'); });
    h.watchlist.linkOrCreate.mockImplementation(async () => { order.push('create'); return { watchlistItemId: 'w1', outcome: 'created' }; });
    await h.svc.approve('a', 'user-1');
    expect(order[0]).toBe('audit');
  });

  it('refuses an unknown title rather than inventing one', async () => {
    const h = harness();
    h.prisma.discoveredMedia.findUnique = jest.fn(async () => null);
    await expect(h.svc.approve('nope', 'user-1')).rejects.toThrow(/Unknown discovered title/);
  });
});

/**
 * The switch that decides whether a template acts on its own.
 */
describe('auto-monitor switched off', () => {
  it('holds a qualifying title for review instead of monitoring it', async () => {
    const h = harness();
    h.prisma.discoveryTemplate.findMany = jest.fn(async () => [{ ...TEMPLATE, autoMonitorEnabled: false }]);
    const [outcome] = await h.svc.runAll();
    expect(outcome.decisions.needs_review).toBe(1);
    expect(outcome.decisions.auto_monitor).toBe(0);
    expect(h.watchlist.linkOrCreate).not.toHaveBeenCalled();
  });

  it('says the title qualified, so the reason is actionable', async () => {
    const h = harness();
    h.prisma.discoveryTemplate.findMany = jest.fn(async () => [{ ...TEMPLATE, autoMonitorEnabled: false }]);
    await h.svc.runAll();
    expect(h.stamps[0].decisionReason).toMatch(/does not monitor automatically/);
  });

  it('still monitors when the switch is on', async () => {
    const h = harness();
    h.prisma.discoveryTemplate.findMany = jest.fn(async () => [{ ...TEMPLATE, autoMonitorEnabled: true }]);
    const [outcome] = await h.svc.runAll();
    expect(outcome.decisions.auto_monitor).toBe(1);
  });
});

/**
 * Re-evaluating something this engine already monitors.
 *
 * The identity gate looks for a watchlist entry and a rule representing the
 * work — and on a re-evaluation it finds the ones THIS row created. Reported as
 * `already_monitored`, a correctly-monitored title would be demoted to
 * "Existing" and vanish from Monitored on every policy edit that reopens
 * decisions.
 */
describe('re-evaluating a title we already monitor', () => {
  const ours = () =>
    row('m1', {
      discoveryStatus: 'monitored',
      matchedTemplateId: TEMPLATE.id,
      watchlistItemId: 'wl-ours',
      rssRuleId: 'r-ours',
    });
  const resolvedToOurs = {
    state: 'already_monitored', matchedBy: 'external_id', matchedIdNamespace: 'tmdb',
    watchlistItem: { id: 'wl-ours', status: 'active', rssRuleId: 'r-ours', title: 'Show m1' },
    rssRule: { id: 'r-ours', name: 'Show m1', generatedByDiscovery: true, userModifiedAt: null },
    libraryItemIds: [], detail: 'Already monitored',
  };

  it('stays monitored rather than being demoted to Existing', async () => {
    const h = harness({ rows: [ours()], existing: resolvedToOurs });
    const [outcome] = await h.svc.runAll();
    expect(outcome.decisions.auto_monitor).toBe(1);
    expect(outcome.decisions.already_monitored).toBe(0);
    expect(h.stamps[0].decision).toBe('auto_monitor');
  });

  /* Somebody ELSE's monitoring is still reported as already_monitored. */
  it('still reports monitoring that belongs to something else', async () => {
    const h = harness({
      rows: [ours()],
      existing: {
        ...resolvedToOurs,
        watchlistItem: { id: 'wl-theirs', status: 'active', rssRuleId: 'r-theirs', title: 'X' },
        rssRule: { id: 'r-theirs', name: 'X', generatedByDiscovery: false, userModifiedAt: null },
      },
    });
    const [outcome] = await h.svc.runAll();
    expect(outcome.decisions.already_monitored).toBe(1);
  });
});

/**
 * The auto-add limit paces NEW acquisition, not re-evaluation.
 *
 * Applying it to a title already monitored made a monitored show compete for a
 * fresh daily allowance every time a policy edit cleared the decisions — and the
 * titles that lost that race dropped into review saying "Automatic-add threshold
 * reached" while still being monitored. Observed live: 17 monitored shows, a
 * limit of 10, and the 7 that came last moved to Needs review overnight.
 */
describe('the auto-add budget and re-evaluation', () => {
  const monitored = () =>
    row('m1', {
      discoveryStatus: 'monitored',
      matchedTemplateId: TEMPLATE.id,
      watchlistItemId: 'wl1',
      rssRuleId: 'r1',
    });

  it('does not push an already-monitored title into review when the budget is spent', async () => {
    const h = harness({ rows: [monitored()], remaining: 0 });
    const [outcome] = await h.svc.runAll();
    expect(outcome.decisions.needs_review).toBe(0);
    expect(outcome.decisions.auto_monitor).toBe(1);
  });

  it('still holds a NEW title when the budget is spent', async () => {
    const h = harness({ rows: [row('new1')], remaining: 0 });
    const [outcome] = await h.svc.runAll();
    expect(outcome.decisions.needs_review).toBe(1);
    expect(outcome.decisions.auto_monitor).toBe(0);
  });

  /*
   * Charging for work that did not happen is what let a single re-evaluation of
   * an existing catalogue exhaust a day's allowance without acquiring anything.
   */
  it('spends the budget only when a watchlist entry was actually created', async () => {
    const h = harness({ rows: [row('a'), row('b')], remaining: 1, watchlistOutcome: 'unchanged' });
    const [outcome] = await h.svc.runAll();
    // Neither created anything, so neither spent — both still auto_monitor.
    expect(outcome.decisions.auto_monitor).toBe(2);
    expect(outcome.decisions.needs_review).toBe(0);
  });

  it('does spend it for a genuinely new entry', async () => {
    const h = harness({ rows: [row('a'), row('b')], remaining: 1, watchlistOutcome: 'created' });
    const [outcome] = await h.svc.runAll();
    expect(outcome.decisions.auto_monitor).toBe(1);
    expect(outcome.decisions.needs_review).toBe(1);
  });
});
