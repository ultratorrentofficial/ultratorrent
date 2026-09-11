import { MediaServerSessionService } from './media-server-session.service';

/**
 * `liveActivity()` uses an explicit `select` rather than a bare `findMany()`, so
 * a new column is never put on the wire by accident. `ipAddress` IS now selected
 * and surfaced on purpose — the operator asked to see where a viewer streams
 * from, and this endpoint is analytics-permissioned — with its offline-resolved
 * location attached. These pin that projection.
 */
function build(rows: any[]) {
  const prisma: any = {
    mediaServerSession: { findMany: jest.fn(async () => rows) },
    // The listing resolves each viewer's display name against the account list.
    mediaServerUser: { findMany: jest.fn(async () => []) },
  };
  const svc = new MediaServerSessionService(
    prisma, {} as any, {} as any, {} as any, { publish: jest.fn(() => ({ published: true })) } as any,
    { lookupMany: async () => new Map() } as any,
  );
  return { svc, prisma };
}

const row = (over: any = {}) => ({
  id: 's1', connectionId: 'c1', userName: 'Dennis', title: 'Dune',
  showTitle: null, seasonNumber: null, episodeNumber: null, year: 2021,
  mediaType: 'movie', libraryName: 'Movies', device: 'Apple TV', client: 'Plex',
  playbackState: 'playing', progressPercent: 12, playbackMethod: 'directplay',
  videoCodec: 'hevc', audioCodec: 'eac3', resolution: '1080p', container: 'mkv',
  bitrateKbps: 8000, artPath: '/library/metadata/9/thumb/1',
  startedAt: new Date(), updatedAt: new Date(), ...over,
});

describe('liveActivity projection', () => {
  it('selects explicit columns rather than returning the whole row', async () => {
    const { svc, prisma } = build([row()]);
    await svc.liveActivity();
    const args = prisma.mediaServerSession.findMany.mock.calls[0][0];
    expect(args.select).toBeDefined();
    // artPath is still projected to a boolean, never sent raw.
    expect(args.select.artPath).toBe(true);
  });

  it('surfaces ipAddress and its resolved location', async () => {
    // The operator asked to see the viewer's address; a private one resolves to
    // no geography (the frontend renders that as "Local").
    const { svc } = build([row({ ipAddress: '10.220.35.77' })]);
    const out = await svc.liveActivity();
    const first = out[0] as unknown as Record<string, unknown>;
    expect(first.ipAddress).toBe('10.220.35.77');
    // A no-op geoip stub attaches null; the point is the field is present.
    expect('geo' in first).toBe(true);
  });

  it('replaces the provider art path with a boolean', async () => {
    const { svc } = build([row()]);
    const out = await svc.liveActivity();
    expect(out[0].hasArtwork).toBe(true);
    expect(JSON.stringify(out)).not.toContain('/library/metadata');
  });

  it('reports no artwork when the session has none', async () => {
    const { svc } = build([row({ artPath: null })]);
    expect((await svc.liveActivity())[0].hasArtwork).toBe(false);
  });

  it('still carries the fields the dashboard renders', async () => {
    const { svc } = build([row()]);
    const out = await svc.liveActivity();
    expect(out[0]).toMatchObject({
      userName: 'Dennis', title: 'Dune', resolution: '1080p',
      playbackMethod: 'directplay', progressPercent: 12, year: 2021,
    });
  });
});
