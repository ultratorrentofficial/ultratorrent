import { MediaServerSyncService } from './media-server-sync.service';

/**
 * The friendly name is stored here, not pushed to Plex — and that is a finding,
 * not a shortcut. A shared Plex user's name IS their own plex.tv profile: the
 * server owner has no API to change it, and changing it would rename them on
 * every server they use. Only home/managed users can be renamed in Plex at all,
 * and a server may have none — on the installation this was built for, all 34
 * users were shared accounts, so writing to Plex would have fixed nothing.
 */
describe('a media-server user friendly name', () => {
  const svcWith = (update: jest.Mock) =>
    new MediaServerSyncService(
      { mediaServerUser: { update } } as never,
      {} as never, {} as never, {} as never,
    );

  it('stores a trimmed override', async () => {
    const update = jest.fn().mockResolvedValue({});
    await svcWith(update).setUserDisplayName('u1', '  Dennis Ayala  ');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { displayName: 'Dennis Ayala' },
    });
  });

  it('clears the override when given blank, falling back to the synced name', async () => {
    const update = jest.fn().mockResolvedValue({});
    await svcWith(update).setUserDisplayName('u1', '   ');
    expect(update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { displayName: null } });
  });

  it('treats null as a clear rather than an error', async () => {
    const update = jest.fn().mockResolvedValue({});
    await svcWith(update).setUserDisplayName('u1', null);
    expect(update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { displayName: null } });
  });

  it('never writes userName, so a later sync cannot be confused by the override', async () => {
    const update = jest.fn().mockResolvedValue({});
    await svcWith(update).setUserDisplayName('u1', 'Maria Ayala');
    const [[arg]] = update.mock.calls;
    expect(Object.keys(arg.data)).toEqual(['displayName']);
  });
});
