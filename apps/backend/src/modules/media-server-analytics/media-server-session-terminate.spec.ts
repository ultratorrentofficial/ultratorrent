import { NotFoundException } from '@nestjs/common';
import { MediaServerSessionService } from './media-server-session.service';

/**
 * Manual stream termination (Phase 1 of Concurrent Stream Control).
 *
 * The service reads the provider-native id off the session row, delegates the
 * stop to the integration layer, audits the attempt with the acting admin, and
 * broadcasts the outcome — and a provider that cannot terminate (Kodi) is a
 * clean "monitor only", not an error.
 */
describe('MediaServerSessionService.terminateStream', () => {
  const ROW = {
    id: 'row-1', connectionId: 'conn-1', providerSessionId: 'psid-9',
    title: 'The Matrix', userName: 'neo', device: 'Roku', client: 'Plex', ipAddress: '203.0.113.9',
  };
  const CTX = { userId: 'admin-1', ipAddress: '10.0.0.2', userAgent: 'jest' };

  const make = (opts: {
    row?: typeof ROW | null;
    terminate: (id: string, psid: string) => Promise<unknown>;
  }) => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const realtime = { broadcast: jest.fn() };
    const integrations = { terminateSession: jest.fn((connId: string, psid: string) => opts.terminate(connId, psid)) };
    const prisma = { mediaServerSession: { findUnique: jest.fn().mockResolvedValue(opts.row === undefined ? ROW : opts.row) } };
    const svc = new MediaServerSessionService(
      prisma as never, integrations as never, realtime as never,
      {} as never, {} as never, {} as never, audit as never,
    );
    return { svc, audit, realtime, integrations, prisma };
  };

  it('stops a supported session, audits success, and broadcasts terminated', async () => {
    const { svc, audit, realtime, integrations } = make({
      terminate: async () => ({ supported: true, result: { success: true, sessionId: 'psid-9', provider: 'plex' } }),
    });
    const r = await svc.terminateStream('row-1', CTX, 'stop msg');
    expect(r).toEqual({ supported: true, success: true, message: undefined });
    expect(integrations.terminateSession).toHaveBeenCalledWith('conn-1', 'psid-9', { message: 'stop msg' });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'media_server_analytics.session.terminated', result: 'success', userId: 'admin-1', objectId: 'row-1',
    }));
    expect(realtime.broadcast).toHaveBeenCalledWith('media_server.stream.terminated', expect.objectContaining({ sessionId: 'row-1' }));
  });

  it('records failure and broadcasts termination_failed when the provider declines', async () => {
    const { svc, audit, realtime } = make({
      terminate: async () => ({ supported: true, result: { success: false, sessionId: 'psid-9', provider: 'plex', message: 'HTTP 404' } }),
    });
    const r = await svc.terminateStream('row-1', CTX);
    expect(r).toMatchObject({ supported: true, success: false });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'media_server_analytics.session.terminated', result: 'failure' }));
    expect(realtime.broadcast).toHaveBeenCalledWith('media_server.stream.termination_failed', expect.anything());
  });

  it('treats an unsupported provider as monitor-only (no broadcast, distinct audit)', async () => {
    const { svc, audit, realtime } = make({
      terminate: async () => ({ supported: false, message: 'kodi does not support "terminateSession".' }),
    });
    const r = await svc.terminateStream('row-1', CTX);
    expect(r).toMatchObject({ supported: false, success: false });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'media_server_analytics.session.terminate_unsupported', result: 'failure' }));
    expect(realtime.broadcast).not.toHaveBeenCalled();
  });

  it('throws when the session row is gone', async () => {
    const { svc } = make({ row: null, terminate: async () => ({ supported: true, result: { success: true } }) });
    await expect(svc.terminateStream('missing', CTX)).rejects.toBeInstanceOf(NotFoundException);
  });
});
