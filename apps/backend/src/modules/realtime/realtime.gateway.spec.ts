import { PERMISSIONS, SystemRole, WS_EVENTS } from '@ultratorrent/shared';
import { RealtimeGateway } from './realtime.gateway';

function makeGateway(verifyResult: unknown) {
  const jwt = { verifyAsync: jest.fn().mockResolvedValue(verifyResult) } as any;
  const config = { get: jest.fn().mockReturnValue('secret') } as any;
  const gateway = new RealtimeGateway(jwt, config);
  const emit = jest.fn();
  (gateway as any).server = { to: jest.fn().mockReturnValue({ emit }) };
  return { gateway, emit };
}

function fakeClient() {
  return {
    handshake: { auth: { token: 't' }, query: {} },
    data: {} as Record<string, unknown>,
    join: jest.fn(),
    disconnect: jest.fn(),
  } as any;
}

describe('RealtimeGateway — permission-scoped feeds', () => {
  it('routes each event to its permission room', () => {
    const { gateway } = makeGateway({});
    const server = (gateway as any).server;

    gateway.broadcast(WS_EVENTS.TORRENTS_UPDATE, {});
    expect(server.to).toHaveBeenCalledWith(`perm:${PERMISSIONS.TORRENTS_VIEW}`);

    gateway.broadcast(WS_EVENTS.STATS_UPDATE, {});
    expect(server.to).toHaveBeenCalledWith(`perm:${PERMISSIONS.TORRENTS_VIEW}`);

    gateway.broadcast(WS_EVENTS.FILES_TRASH_UPDATED, {});
    expect(server.to).toHaveBeenCalledWith(`perm:${PERMISSIONS.FILES_VIEW}`);

    gateway.broadcast(WS_EVENTS.NOTIFICATION, {});
    expect(server.to).toHaveBeenCalledWith('authenticated');
  });

  it('joins only the feeds the user is permitted to read', async () => {
    const { gateway } = makeGateway({
      sub: 'u1',
      permissions: [PERMISSIONS.TORRENTS_VIEW],
      roles: [SystemRole.USER],
    });
    const client = fakeClient();
    await gateway.handleConnection(client);
    const joined = client.join.mock.calls.map((c: unknown[]) => c[0]);
    expect(joined).toContain('authenticated');
    expect(joined).toContain('user:u1');
    expect(joined).toContain(`perm:${PERMISSIONS.TORRENTS_VIEW}`);
    expect(joined).not.toContain(`perm:${PERMISSIONS.FILES_VIEW}`);
  });

  it('gives SUPER_ADMIN every feed', async () => {
    const { gateway } = makeGateway({ sub: 'root', permissions: [], roles: [SystemRole.SUPER_ADMIN] });
    const client = fakeClient();
    await gateway.handleConnection(client);
    const joined = client.join.mock.calls.map((c: unknown[]) => c[0]);
    expect(joined).toContain(`perm:${PERMISSIONS.TORRENTS_VIEW}`);
    expect(joined).toContain(`perm:${PERMISSIONS.FILES_VIEW}`);
  });

  it('disconnects a client with an invalid token', async () => {
    const jwt = { verifyAsync: jest.fn().mockRejectedValue(new Error('bad')) } as any;
    const config = { get: jest.fn() } as any;
    const gateway = new RealtimeGateway(jwt, config);
    const client = fakeClient();
    await gateway.handleConnection(client);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });
});
