/**
 * Live Activity names the viewer, not their login.
 *
 * `resolveViewerName` already existed and was already correct — playback alerts
 * had used it since they were built. The Live Activity LISTING never called it,
 * so the one screen whose entire job is showing who is watching was the one
 * place still printing `j.smith`.
 *
 * The listing keeps `userName` as the provider reported it (analytics group by
 * that value) and carries the resolved name alongside it.
 */
import { MediaServerSessionService } from './media-server-session.service';

const ACCOUNTS = [
  { connectionId: null, providerUserId: '383757', userName: 'Jane Smith', email: 'jane@example.com' },
  { connectionId: null, providerUserId: '19587074', userName: 'Madeline Ayala', email: 'm@example.com' },
];

const session = (over: Record<string, unknown> = {}) => ({
  id: 's1', connectionId: 'c1', userName: 'j.smith', providerUserId: '1',
  title: 'The Lantern Problem', showTitle: null, seasonNumber: null, episodeNumber: null,
  year: 2023, mediaType: 'movie', libraryName: 'Films', device: 'Apple TV', client: 'Plex',
  playbackState: 'playing', progressPercent: 12, playbackMethod: 'directplay',
  videoCodec: 'hevc', audioCodec: 'eac3', resolution: '4k', container: 'mkv',
  bitrateKbps: 20000, artPath: null, startedAt: new Date(), updatedAt: new Date(),
  ...over,
});

function build(sessions: Array<Record<string, unknown>>, accounts = ACCOUNTS) {
  const counts = { users: 0 };
  const prisma = {
    mediaServerSession: { findMany: jest.fn(async () => sessions) },
    mediaServerUser: {
      findMany: jest.fn(async () => {
        counts.users += 1;
        return accounts;
      }),
    },
  };
  const svc = new MediaServerSessionService(
    prisma as never, {} as never, {} as never, {} as never, {} as never,
  );
  return { svc, prisma, counts };
}

describe('liveActivity viewer names', () => {
  it('resolves the owner exactly once sessions carry their real id', async () => {
    // The state after the provider fix: no name inference is involved, the id
    // simply matches the account.
    const { svc } = build([session({ providerUserId: '383757' })]);
    const [row] = await svc.liveActivity();
    expect(row.userDisplayName).toBe('Jane Smith');
  });

  it('still rescues a legacy row whose handle normalizes to the account name', async () => {
    // Rows written before the provider fix keep local id 1. `dennis.ayala` and
    // `Dennis Ayala` reduce to the same string, so those resolve by name.
    const { svc } = build(
      [session({ userName: 'dennis.ayala', providerUserId: '1' })],
      [{ connectionId: null, providerUserId: '383757', userName: 'Dennis Ayala', email: 'd@example.com' }],
    );
    const [row] = await svc.liveActivity();
    expect(row.userDisplayName).toBe('Dennis Ayala');
  });

  it('refuses to guess when a legacy handle does not normalize to any account', async () => {
    /*
     * `j.smith` does not reduce to `janesmith`, and attributing one person's
     * viewing to another is worse than showing a handle. This is the case that
     * name matching CANNOT reach — and the reason the fix belongs in the Plex
     * provider, which translates the id at the source, rather than here.
     */
    const { svc } = build([session({ userName: 'j.smith', providerUserId: '1' })]);
    const [row] = await svc.liveActivity();
    expect(row.userDisplayName).toBe('j.smith');
  });

  it('keeps the provider value on userName', async () => {
    // Analytics group by this; rewriting it would split one person's history
    // across two spellings.
    const { svc } = build([session()]);
    const [row] = await svc.liveActivity();
    expect(row.userName).toBe('j.smith');
  });

  it('resolves an ordinary user by id without inference', async () => {
    const { svc } = build([session({ userName: 'madeline24', providerUserId: '19587074' })]);
    const [row] = await svc.liveActivity();
    expect(row.userDisplayName).toBe('Madeline Ayala');
  });

  it('falls back to the session name when nothing matches', async () => {
    // Showing a handle beats showing nothing, and beats guessing a person.
    const { svc } = build([session({ userName: 'stranger', providerUserId: '99999' })]);
    const [row] = await svc.liveActivity();
    expect(row.userDisplayName).toBe('stranger');
  });

  it('leaves an anonymous session null rather than inventing a viewer', async () => {
    const { svc } = build([session({ userName: null, providerUserId: null })]);
    const [row] = await svc.liveActivity();
    expect(row.userDisplayName).toBeNull();
  });

  it('reads the account list once for the whole page, not once per session', async () => {
    /*
     * The regression this guards is quiet: resolving inside the map is correct
     * and issues one query per playing session, on an endpoint the page polls.
     */
    const { svc, counts } = build([
      session({ id: 'a' }),
      session({ id: 'b', userName: 'madeline24', providerUserId: '19587074' }),
      session({ id: 'c', userName: 'stranger', providerUserId: '99999' }),
    ]);
    const rows = await svc.liveActivity();
    expect(rows).toHaveLength(3);
    expect(counts.users).toBe(1);
  });

  it('still withholds the viewer IP', async () => {
    // The listing maps field by field precisely to guard this; adding a field
    // to that map is exactly when it could be undone.
    const { svc } = build([session({ ipAddress: '10.0.0.5' })]);
    const [row] = await svc.liveActivity();
    expect(JSON.stringify(row)).not.toContain('10.0.0.5');
  });
});
