import { MediaServerSyncService } from './media-server-sync.service';

/**
 * Accounts on different products are different accounts, full stop.
 *
 * A provider id is unique only inside one product's id space — Plex numbers its
 * accounts (the owner is literally `1`) while Jellyfin and Emby use GUIDs. The
 * dedupe used to group on the bare id, so a collision across products would have
 * DELETED one of two unrelated people. Even an identical email is not proof of
 * one person (a household device shares an address), so nothing is merged across
 * products regardless.
 */
describe('user dedupe stays inside one product', () => {
  const build = (users: Array<Record<string, unknown>>, integrations: Array<Record<string, unknown>>) => {
    const deleted: string[][] = [];
    const prisma = {
      mediaServerUser: {
        findMany: jest.fn().mockResolvedValue(users),
        update: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) => {
          deleted.push(where.id.in);
          return Promise.resolve({ count: where.id.in.length });
        }),
      },
      mediaServerIntegration: { findMany: jest.fn().mockResolvedValue(integrations) },
    };
    const svc = new MediaServerSyncService(prisma as never, {} as never, {} as never, {} as never);
    return { svc, deleted, prisma };
  };

  const run = (svc: MediaServerSyncService) =>
    (svc as unknown as { dedupeUsersByProviderId(): Promise<void> }).dedupeUsersByProviderId();

  it('never merges a Plex account with a Jellyfin one that shares an id', async () => {
    const { svc, deleted } = build(
      [
        { id: 'u-plex', connectionId: 'c-plex', providerUserId: '1', plays: 87, email: 'a@x.co' },
        { id: 'u-jf', connectionId: 'c-jf', providerUserId: '1', plays: 0, email: null },
      ],
      [{ id: 'c-plex', kind: 'plex' }, { id: 'c-jf', kind: 'jellyfin' }],
    );
    await run(svc);
    expect(deleted).toEqual([]); // both rows survive
  });

  it('still collapses two rows for one account on the SAME product', async () => {
    const { svc, deleted } = build(
      [
        { id: 'keep', connectionId: 'c-plex', providerUserId: '9', plays: 40, email: null },
        { id: 'drop', connectionId: 'c-plex', providerUserId: '9', plays: 2, email: 'a@x.co' },
      ],
      [{ id: 'c-plex', kind: 'plex' }],
    );
    await run(svc);
    expect(deleted).toEqual([['drop']]);
  });

  it('folds imported history in when only one product is present', async () => {
    // The Tautulli case: connectionId null, same Plex account id.
    const { svc, deleted } = build(
      [
        { id: 'live', connectionId: 'c-plex', providerUserId: '9', plays: 5, email: null },
        { id: 'imported', connectionId: null, providerUserId: '9', plays: 100, email: 'a@x.co' },
      ],
      [{ id: 'c-plex', kind: 'plex' }],
    );
    await run(svc);
    expect(deleted).toEqual([['live']]); // the 100-play row wins
  });

  it('leaves imported history alone when two products could claim it', async () => {
    const { svc, deleted } = build(
      [
        { id: 'plex', connectionId: 'c-plex', providerUserId: '1', plays: 5, email: null },
        { id: 'jf', connectionId: 'c-jf', providerUserId: '1', plays: 3, email: null },
        { id: 'imported', connectionId: null, providerUserId: '1', plays: 99, email: 'a@x.co' },
      ],
      [{ id: 'c-plex', kind: 'plex' }, { id: 'c-jf', kind: 'jellyfin' }],
    );
    await run(svc);
    // Ambiguous origin: a guess that deletes a row is not worth making.
    expect(deleted).toEqual([]);
  });
});
