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
    users: Array<{ connectionId: string; providerUserId: string | null; userName: string; displayName: string | null }>,
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

  it('leaves the snapshot alone when no display name is set for that viewer', async () => {
    const prisma = makePrisma(
      [{ connectionId: 'c1', providerUserId: '9', userName: 'akafunma' }],
      [{ connectionId: 'c1', providerUserId: '1', userName: 'dennis.ayala', displayName: 'Dennis Ayala' }],
    );
    const { items } = await svc(prisma).watchHistory();
    expect(items[0].userName).toBe('akafunma');
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

  it('does not query users when the page is empty', async () => {
    const prisma = makePrisma([], []);
    await svc(prisma).watchHistory();
    expect(prisma.mediaServerUser.findMany).not.toHaveBeenCalled();
  });
});
