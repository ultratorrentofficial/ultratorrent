import { SystemService } from './system.module';

function svc(values: Record<string, unknown> = {}) {
  const config = { get: (k: string) => values[k] } as any;
  return new SystemService({} as any, {} as any, config);
}

describe('SystemService.version', () => {
  it('reports product, version, and edition from config', () => {
    const v = svc({ 'node.productVersion': '1.2.3', edition: 'enterprise' }).version();
    expect(v).toMatchObject({ product: 'UltraTorrent', version: '1.2.3', edition: 'enterprise', apiVersion: 'v1' });
    expect(v.node).toBe(process.version);
  });

  it('defaults to community + 0.1.0 when unset', () => {
    const v = svc().version();
    expect(v.edition).toBe('community');
    expect(v.version).toBe('0.10.0');
  });

  it('liveness reports ok + uptime', async () => {
    const r = await svc().liveness();
    expect(r.status).toBe('ok');
    expect(typeof r.uptime).toBe('number');
  });
});
