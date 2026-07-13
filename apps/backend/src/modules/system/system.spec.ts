import { SystemService } from './system.module';
import { resolveBuildInfo } from '../../config/build-info';

/**
 * `resolveBuildInfo()` reads the real environment: GIT_* vars, else a `build-info.json`
 * searched UP from cwd. A developer checkout has one — the git hook stamps it on every
 * pull — so without this mock the "falls back to v<version>" test asserted against a
 * real `git describe` (`v0.28.0-20-g0fd6bba-dirty`) and failed on any working tree that
 * had ever been stamped, while passing in CI on a clean clone.
 */
jest.mock('../../config/build-info', () => ({
  resolveBuildInfo: jest.fn(),
  resetBuildInfoCache: jest.fn(),
}));
const mockBuildInfo = resolveBuildInfo as jest.Mock;

const NO_BUILD_INFO = { gitSha: null, gitTag: null, buildTime: null };

function svc(values: Record<string, unknown> = {}) {
  const config = { get: (k: string) => values[k] } as any;
  return new SystemService({} as any, {} as any, config, { emit() {} } as any);
}

describe('SystemService.version', () => {
  beforeEach(() => mockBuildInfo.mockReturnValue(NO_BUILD_INFO));

  it('reports product, version, and edition from config', () => {
    const v = svc({ 'node.productVersion': '1.2.3', edition: 'community' }).version();
    expect(v).toMatchObject({ product: 'UltraTorrent', version: '1.2.3', edition: 'community', apiVersion: 'v1' });
    // gitTag falls back to `v<version>` when GIT_TAG isn't set at build.
    expect(v.gitTag).toBe('v1.2.3');
    expect(v.node).toBe(process.version);
  });

  it('prefers the build stamp over the version-derived tag when one was baked in', () => {
    mockBuildInfo.mockReturnValue({
      gitSha: 'abc1234',
      gitTag: 'v1.2.3-4-gabc1234',
      buildTime: '2026-07-13T00:00:00Z',
    });
    const v = svc({ 'node.productVersion': '1.2.3' }).version();
    expect(v.gitTag).toBe('v1.2.3-4-gabc1234');
    expect(v.gitSha).toBe('abc1234');
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
