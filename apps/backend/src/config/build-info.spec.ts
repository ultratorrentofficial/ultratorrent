import { readFileSync } from 'node:fs';
import { resolveBuildInfo, resetBuildInfoCache } from './build-info';

jest.mock('node:fs', () => ({ readFileSync: jest.fn() }));
const mockRead = readFileSync as jest.Mock;

describe('resolveBuildInfo', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    resetBuildInfoCache();
    mockRead.mockReset();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GIT_SHA;
    delete process.env.GIT_TAG;
    delete process.env.BUILD_TIME;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('prefers env vars (the Docker build args) over the baked file', () => {
    process.env.GIT_SHA = 'envsha';
    process.env.GIT_TAG = 'envtag';
    process.env.BUILD_TIME = 'envtime';
    mockRead.mockReturnValue(
      JSON.stringify({ gitSha: 'filesha', gitTag: 'filetag', buildTime: 'filetime' }),
    );
    expect(resolveBuildInfo()).toEqual({ gitSha: 'envsha', gitTag: 'envtag', buildTime: 'envtime' });
  });

  it('falls back to build-info.json when env is unset (plain docker compose build)', () => {
    mockRead.mockReturnValueOnce(
      JSON.stringify({ gitSha: 'filesha', gitTag: 'filetag', buildTime: '2026-01-01T00:00:00Z' }),
    );
    expect(resolveBuildInfo()).toEqual({
      gitSha: 'filesha',
      gitTag: 'filetag',
      buildTime: '2026-01-01T00:00:00Z',
    });
  });

  it('merges per-field: env sha wins, tag/time come from the file', () => {
    process.env.GIT_SHA = 'envsha';
    mockRead.mockReturnValue(
      JSON.stringify({ gitSha: 'filesha', gitTag: 'filetag', buildTime: 'filetime' }),
    );
    expect(resolveBuildInfo()).toEqual({ gitSha: 'envsha', gitTag: 'filetag', buildTime: 'filetime' });
  });

  it('returns nulls when neither env nor a readable file provide values', () => {
    mockRead.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(resolveBuildInfo()).toEqual({ gitSha: null, gitTag: null, buildTime: null });
  });

  it('treats blank / whitespace / non-string values as null', () => {
    mockRead.mockReturnValue(JSON.stringify({ gitSha: '   ', gitTag: '', buildTime: null }));
    expect(resolveBuildInfo()).toEqual({ gitSha: null, gitTag: null, buildTime: null });
  });

  it('caches after first resolve (values are fixed for the process life)', () => {
    mockRead.mockReturnValue(JSON.stringify({ gitSha: 'a', gitTag: 'b', buildTime: 'c' }));
    const first = resolveBuildInfo();
    mockRead.mockReturnValue(JSON.stringify({ gitSha: 'x', gitTag: 'y', buildTime: 'z' }));
    expect(resolveBuildInfo()).toBe(first);
  });
});
