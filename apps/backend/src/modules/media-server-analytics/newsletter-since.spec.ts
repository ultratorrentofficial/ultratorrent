import { MediaServerNewsletterService } from './media-server-newsletter.service';

/**
 * The `since()` resolver decides the "included since" date from the configured
 * date-range mode — the core of the new start-date feature. It touches no deps,
 * so we exercise it directly with stubbed constructor args.
 */
function svc() {
  return new MediaServerNewsletterService({} as any, {} as any, {} as any, {} as any, {} as any);
}
const since = (n: Record<string, unknown>) => (svc() as any).since(n) as Date;

describe('newsletter since() date-range resolution', () => {
  it('since_date uses the fixed startDate', () => {
    const start = new Date('2026-01-15T00:00:00Z');
    expect(since({ dateRangeMode: 'since_date', startDate: start, lastDays: 7 })).toEqual(start);
  });

  it('since_date falls back to last_days when no startDate is set', () => {
    const d = since({ dateRangeMode: 'since_date', startDate: null, lastDays: 10 });
    const expected = Date.now() - 10 * 24 * 3600 * 1000;
    expect(Math.abs(d.getTime() - expected)).toBeLessThan(5000);
  });

  it('since_last_send uses the last successful send timestamp', () => {
    const last = new Date('2026-06-01T00:00:00Z');
    expect(since({ dateRangeMode: 'since_last_send', lastSuccessfulSendAt: last, lastDays: 7 })).toEqual(last);
  });

  it('since_last_send falls back to last_days on first run', () => {
    const d = since({ dateRangeMode: 'since_last_send', lastSuccessfulSendAt: null, lastDays: 30 });
    const expected = Date.now() - 30 * 24 * 3600 * 1000;
    expect(Math.abs(d.getTime() - expected)).toBeLessThan(5000);
  });

  it('last_days uses the rolling window', () => {
    const d = since({ dateRangeMode: 'last_days', lastDays: 3 });
    const expected = Date.now() - 3 * 24 * 3600 * 1000;
    expect(Math.abs(d.getTime() - expected)).toBeLessThan(5000);
  });
});
