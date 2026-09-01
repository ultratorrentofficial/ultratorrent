import { MediaServerIntegrationService } from './media-server-integration.service';

/**
 * `testConfig` (probe an unsaved connection) must return the SAME shape as
 * `healthCheck` (probe a saved one).
 *
 * It did not, and the mismatch shipped: testConfig returned the provider's
 * `{ ok }` while healthCheck returns `{ reachable }`, so the Add-connection
 * dialog — which checks `reachable` — painted a successful probe red, with
 * "Connected to Jellyfin." written inside the failure box. The frontend test
 * missed it because it mocked the shape the UI expected rather than the one the
 * server sends. Hence a contract test on the server side.
 */
describe('MediaServerIntegrationService.testConfig', () => {
  const svc = () => new MediaServerIntegrationService({} as never, {} as never, {} as never);

  it('reports reachability as `reachable`, never as `ok`', async () => {
    const res = (await svc().testConfig({
      kind: 'jellyfin',
      config: { baseUrl: 'http://127.0.0.1:1' }, // nothing listens; the probe fails
    })) as unknown as Record<string, unknown>;

    expect(res).toHaveProperty('reachable');
    expect(res.ok).toBeUndefined();
    expect(res.reachable).toBe(false);
    expect(typeof res.message).toBe('string');
  });

  it('names the kind and its capabilities even on a failed probe', async () => {
    const res = (await svc().testConfig({
      kind: 'jellyfin',
      config: { baseUrl: 'http://127.0.0.1:1' },
    })) as unknown as Record<string, unknown>;
    expect(res.kind).toBe('jellyfin');
    expect(res.capabilities).toBeDefined();
  });

  it('rejects an unsupported kind rather than probing it', async () => {
    await expect(svc().testConfig({ kind: 'nope', config: {} })).rejects.toThrow();
  });

  it('requires a kind', async () => {
    await expect(svc().testConfig({ config: {} })).rejects.toThrow();
  });
});
