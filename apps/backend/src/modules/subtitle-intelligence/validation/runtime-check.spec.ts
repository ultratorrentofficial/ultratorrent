import { runtimeCrossCheck } from './runtime-check';

describe('runtimeCrossCheck', () => {
  it('returns no delta/issue when runtime is unknown', () => {
    expect(runtimeCrossCheck(1000, null)).toEqual({ runtimeDeltaSec: null, issue: null });
    expect(runtimeCrossCheck(null, 1400)).toEqual({ runtimeDeltaSec: null, issue: null });
    expect(runtimeCrossCheck(1000, 0)).toEqual({ runtimeDeltaSec: null, issue: null });
  });

  it('passes a subtitle that ends within the media runtime', () => {
    // subtitle ends at 1380s, media is 1400s → ends 20s early, fine
    const r = runtimeCrossCheck(1_380_000, 1400);
    expect(r.runtimeDeltaSec).toBe(-20);
    expect(r.issue).toBeNull();
  });

  it('tolerates a small overrun', () => {
    const r = runtimeCrossCheck(1_420_000, 1400); // +20s, within 30s tolerance
    expect(r.issue).toBeNull();
  });

  it('flags a subtitle that overruns the media runtime', () => {
    const r = runtimeCrossCheck(1_500_000, 1400); // +100s
    expect(r.runtimeDeltaSec).toBe(100);
    expect(r.issue?.code).toBe('runtime_overrun');
    expect(r.issue?.severity).toBe('error');
  });
});
