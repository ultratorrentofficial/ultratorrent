import { MediaServerSessionService } from './media-server-session.service';

/**
 * `liveActivity()` used to be a bare `findMany()`, which put every column on the
 * wire — including `ipAddress`, measured as populated on a live install. The
 * frontend type happened not to declare it, but a TypeScript type is not a
 * security boundary. These pin the projection.
 */
function build(rows: any[]) {
  const prisma: any = {
    mediaServerSession: { findMany: jest.fn(async () => rows) },
  };
  const svc = new MediaServerSessionService(
    prisma, {} as any, {} as any, {} as any,
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
    expect(args.select.ipAddress).toBeUndefined();
  });

  it('never puts ipAddress on the wire', async () => {
    // Even if the row carries one, the projection must not surface it.
    const { svc } = build([row({ ipAddress: '10.220.35.77' })]);
    const out = await svc.liveActivity();
    expect(JSON.stringify(out)).not.toContain('10.220.35.77');
    // The type no longer declares it either — this pins the RUNTIME shape.
    expect((out[0] as unknown as Record<string, unknown>).ipAddress).toBeUndefined();
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
