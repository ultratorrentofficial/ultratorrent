import { MediaDiscoveryController } from './media-discovery.controller';

/**
 * A disabled provider must not be contacted.
 *
 * The hourly tick always filtered on `enabled: true`. The manual "Refresh
 * catalogues" endpoint defaulted to `registry.all()` — every REGISTERED
 * provider — so the two paths disagreed and pressing the button synced providers
 * the operator had switched off. Measured on a live installation: TVmaze at
 * `enabled=false`, a successful sync minutes earlier, 540 items discovered, 392
 * rows in the catalogue.
 *
 * That is not a cosmetic inconsistency. "Providers are silent until you enable
 * one" is the second of three doors between a fresh install and an automatic
 * download, and it is a promise about third-party NETWORK CALLS.
 */

function harness(enabled: string[], registered = ['tmdb', 'tvmaze']) {
  const synced: string[][] = [];
  const prisma: any = {
    discoveryProviderState: {
      findMany: jest.fn(async () => enabled.map((provider) => ({ provider }))),
    },
    discoveredMedia: { findMany: jest.fn(async () => []) },
  };
  const registry: any = { all: () => registered.map((name) => ({ name })) };
  const sync: any = {
    syncProviders: jest.fn(async (names: string[]) => {
      synced.push(names);
      return names.map((provider) => ({ provider, discovered: 0, created: 0, updated: 0, failed: 0, suppressed: 0, durationMs: 1 }));
    }),
  };
  const evaluation: any = { runAll: jest.fn(async () => []) };
  const audit: any = { record: jest.fn(async () => undefined) };
  const controller = new MediaDiscoveryController(
    prisma, audit, registry, sync, {} as any, evaluation, {} as any, {} as any,
    {} as any, {} as any,
  );
  return { controller, sync, synced, audit };
}

// `reqAuditContext` reads headers to find the real client behind a proxy, so a
// bare object is not a sufficient stand-in for a request.
const req = { user: { id: 'u1' }, headers: {}, ip: '127.0.0.1', socket: {} } as any;

describe('manual refresh only contacts enabled providers', () => {
  it('does not sync a provider that is switched off', async () => {
    const h = harness(['tmdb']); // tvmaze registered but disabled
    await h.controller.runSync({}, req);
    expect(h.synced).toEqual([['tmdb']]);
    expect(h.synced[0]).not.toContain('tvmaze');
  });

  /*
   * Naming a disabled provider explicitly must not override the switch — that
   * would make the endpoint a way around the operator's own decision.
   */
  it('refuses a disabled provider even when the caller names it', async () => {
    const h = harness(['tmdb']);
    const result: any = await h.controller.runSync({ providers: ['tvmaze'] }, req);
    expect(h.sync.syncProviders).not.toHaveBeenCalled();
    expect(result.message).toMatch(/tvmaze/);
    expect(result.skipped).toEqual(['tvmaze']);
  });

  it('reports what it skipped rather than silently dropping it', async () => {
    const h = harness(['tmdb']);
    const result: any = await h.controller.runSync({ providers: ['tmdb', 'tvmaze'] }, req);
    expect(h.synced).toEqual([['tmdb']]);
    expect(result.skipped).toEqual(['tvmaze']);
  });

  it('makes no call at all when nothing is enabled', async () => {
    const h = harness([]);
    const result: any = await h.controller.runSync({}, req);
    expect(h.sync.syncProviders).not.toHaveBeenCalled();
    expect(result.message).toMatch(/No enabled providers|nothing to refresh/);
  });

  it('syncs everything that IS enabled', async () => {
    const h = harness(['tmdb', 'tvmaze']);
    await h.controller.runSync({}, req);
    expect(h.synced[0].sort()).toEqual(['tmdb', 'tvmaze']);
  });

  /* The audit row records what was withheld, not only what ran. */
  it('audits the skipped providers', async () => {
    const h = harness(['tmdb']);
    await h.controller.runSync({ providers: ['tmdb', 'tvmaze'] }, req);
    expect(h.audit.record.mock.calls[0][0].metadata).toMatchObject({
      providers: ['tmdb'],
      skippedDisabled: ['tvmaze'],
    });
  });
});
