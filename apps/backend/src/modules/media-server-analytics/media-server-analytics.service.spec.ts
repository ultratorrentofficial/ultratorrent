import { MediaServerAnalyticsService } from './media-server-analytics.service';

/**
 * The Watch History table shows the operator's friendly name, not the raw
 * handle the media server reported.
 *
 * A history row keeps a snapshot of the name at playback time — for Plex the
 * account `title`, which for many accounts is the login handle. The friendly
 * name lives on `MediaServerUser.displayName`, and the read must apply it, or
 * renaming a viewer changes nothing on the page. This was reported repeatedly
 * from a live server before it was fixed.
 */
describe('MediaServerAnalyticsService.watchHistory — friendly names', () => {
  const makePrisma = (
    rows: Array<{ connectionId: string | null; providerUserId: string | null; userName: string | null }>,
    users: Array<{ connectionId: string | null; providerUserId: string | null; userName: string; displayName: string | null }>,
  ) => ({
    mediaServerWatchHistory: {
      count: jest.fn().mockResolvedValue(rows.length),
      findMany: jest.fn().mockResolvedValue(rows.map((r) => ({ ...r }))),
    },
    mediaServerUser: {
      findMany: jest.fn().mockResolvedValue(users),
    },
  });

  const svc = (prisma: unknown) =>
    new MediaServerAnalyticsService(prisma as never, {} as never);

  it('replaces the stored handle with the display name, matched by providerUserId', async () => {
    const prisma = makePrisma(
      [{ connectionId: 'c1', providerUserId: '1', userName: 'dennis.ayala' }],
      [{ connectionId: 'c1', providerUserId: '1', userName: 'dennis.ayala', displayName: 'Dennis Ayala' }],
    );
    const { items } = await svc(prisma).watchHistory();
    expect(items[0].userName).toBe('Dennis Ayala');
  });

  it('falls back to matching by userName when the row has no providerUserId', async () => {
    const prisma = makePrisma(
      [{ connectionId: 'c1', providerUserId: null, userName: 'EricPastrana' }],
      [{ connectionId: 'c1', providerUserId: '274858595', userName: 'EricPastrana', displayName: 'Eric Pastrana' }],
    );
    const { items } = await svc(prisma).watchHistory();
    expect(items[0].userName).toBe('Eric Pastrana');
  });

  it('keeps the snapshot when no user record matches the row', async () => {
    const prisma = makePrisma(
      [{ connectionId: 'c1', providerUserId: '9', userName: 'akafunma' }],
      [{ connectionId: 'c1', providerUserId: '1', userName: 'dennis.ayala', displayName: 'Dennis Ayala' }],
    );
    const { items } = await svc(prisma).watchHistory();
    expect(items[0].userName).toBe('akafunma');
  });

  /*
   * The bug the operator kept reporting. Live Plex monitoring stored the login
   * handle (`jonathanxir`) while the same person's Tautulli-imported record —
   * with no connection — holds the real name (`Jonathan Medina`). They share a
   * providerUserId, which is the only link, so a live row must reach the legacy
   * record by that id even though the two live in different connection buckets.
   */
  it('bridges a live handle to the pre-connection record by provider id', async () => {
    const prisma = makePrisma(
      [{ connectionId: 'c1', providerUserId: '24891625', userName: 'jonathanxir' }],
      [{ connectionId: null, providerUserId: '24891625', userName: 'Jonathan Medina', displayName: null }],
    );
    const { items } = await svc(prisma).watchHistory();
    expect(items[0].userName).toBe('Jonathan Medina');
  });

  it("prefers the legacy record's display name over its userName on the bridge", async () => {
    const prisma = makePrisma(
      [{ connectionId: 'c1', providerUserId: '571526792', userName: 'akafunma' }],
      [{ connectionId: null, providerUserId: '571526792', userName: 'akafunma', displayName: 'Astrid Masa' }],
    );
    const { items } = await svc(prisma).watchHistory();
    expect(items[0].userName).toBe('Astrid Masa');
  });

  it('keeps the snapshot when the matched record has no better name', async () => {
    // A Jellyfin viewer with no display name set: the record's userName equals
    // the row's, so there is nothing to change.
    const prisma = makePrisma(
      [{ connectionId: 'c2', providerUserId: 'a44428', userName: 'dennis.ayala' }],
      [{ connectionId: 'c2', providerUserId: 'a44428', userName: 'dennis.ayala', displayName: null }],
    );
    const { items } = await svc(prisma).watchHistory();
    expect(items[0].userName).toBe('dennis.ayala');
  });

  it('never borrows a display name across connections', async () => {
    // Same providerUserId on a different server is a different person.
    const prisma = makePrisma(
      [{ connectionId: 'c2', providerUserId: '1', userName: 'guest' }],
      [{ connectionId: 'c1', providerUserId: '1', userName: 'dennis.ayala', displayName: 'Dennis Ayala' }],
    );
    const { items } = await svc(prisma).watchHistory();
    expect(items[0].userName).toBe('guest');
  });

  /*
   * The majority of a live server's history predates connection tracking and
   * carries no connectionId. These share one legacy bucket with the users that
   * also have none, and must resolve — this was the half the first fix missed.
   */
  it('resolves rows and users that both carry no connection', async () => {
    const prisma = makePrisma(
      [{ connectionId: null, providerUserId: '571526792', userName: 'akafunma' }],
      [{ connectionId: null, providerUserId: '571526792', userName: 'akafunma', displayName: 'Astrid Masa' }],
    );
    const { items } = await svc(prisma).watchHistory();
    expect(items[0].userName).toBe('Astrid Masa');
  });

  it('does not let the null legacy bucket borrow from a real connection', async () => {
    const prisma = makePrisma(
      [{ connectionId: null, providerUserId: '1', userName: 'ghost' }],
      [{ connectionId: 'c1', providerUserId: '1', userName: 'dennis.ayala', displayName: 'Dennis Ayala' }],
    );
    const { items } = await svc(prisma).watchHistory();
    expect(items[0].userName).toBe('ghost');
  });

  it('does not query users when the page is empty', async () => {
    const prisma = makePrisma([], []);
    await svc(prisma).watchHistory();
    expect(prisma.mediaServerUser.findMany).not.toHaveBeenCalled();
  });
});
