import {
  isInactiveStatus,
  normalizeShowStatus,
  normalizeTitle,
  recommendationFor,
  type NormalizedShowStatus,
} from './tv-show-status-provider';

describe('normalizeShowStatus', () => {
  it('maps TMDB textual statuses', () => {
    expect(normalizeShowStatus({ providerStatus: 'Returning Series' })).toBe('returning');
    expect(normalizeShowStatus({ providerStatus: 'Ended' })).toBe('ended');
    expect(normalizeShowStatus({ providerStatus: 'Canceled' })).toBe('canceled');
    expect(normalizeShowStatus({ providerStatus: 'Cancelled' })).toBe('canceled');
    expect(normalizeShowStatus({ providerStatus: 'In Production' })).toBe('planned');
    expect(normalizeShowStatus({ providerStatus: 'Planned' })).toBe('planned');
    expect(normalizeShowStatus({ providerStatus: 'Pilot' })).toBe('planned');
    expect(normalizeShowStatus({ providerStatus: 'weird' })).toBe('unknown');
  });

  it('treats a returning show with no upcoming episode and a stale last-air as on_hiatus', () => {
    const now = new Date('2026-07-01T00:00:00Z');
    expect(
      normalizeShowStatus({ providerStatus: 'Returning Series', hasFutureEpisode: false, lastAirDate: '2025-01-01', now }),
    ).toBe('on_hiatus');
    // …but not when a next episode is scheduled
    expect(
      normalizeShowStatus({ providerStatus: 'Returning Series', hasFutureEpisode: true, lastAirDate: '2025-01-01', now }),
    ).toBe('returning');
    // …nor when it aired recently
    expect(
      normalizeShowStatus({ providerStatus: 'Returning Series', hasFutureEpisode: false, lastAirDate: '2026-06-01', now }),
    ).toBe('returning');
  });

  it('derives status from IMDb endYear / assumeContinuing when there is no textual status', () => {
    expect(normalizeShowStatus({ endYear: 2018 })).toBe('ended');
    expect(normalizeShowStatus({ endYear: null, assumeContinuing: true })).toBe('continuing');
    expect(normalizeShowStatus({ endYear: null })).toBe('unknown');
    expect(normalizeShowStatus({})).toBe('unknown');
  });
});

describe('recommendationFor', () => {
  const cases: Array<[NormalizedShowStatus, string]> = [
    ['continuing', 'recommended'],
    ['returning', 'recommended'],
    ['planned', 'recommended'],
    ['on_hiatus', 'caution'],
    ['ended', 'not_recommended'],
    ['canceled', 'not_recommended'],
    ['unknown', 'unknown'],
  ];
  it.each(cases)('maps %s -> %s', (status, rec) => {
    expect(recommendationFor(status)).toBe(rec);
  });
});

describe('isInactiveStatus', () => {
  it('is true only for ended/canceled', () => {
    expect(isInactiveStatus('ended')).toBe(true);
    expect(isInactiveStatus('canceled')).toBe(true);
    expect(isInactiveStatus('returning')).toBe(false);
    expect(isInactiveStatus('on_hiatus')).toBe(false);
    expect(isInactiveStatus('unknown')).toBe(false);
  });
});

describe('normalizeTitle', () => {
  it('lowercases and collapses non-alphanumerics', () => {
    expect(normalizeTitle('The Expanse (2015)')).toBe('the expanse 2015');
    expect(normalizeTitle('  Mr. Robot!! ')).toBe('mr robot');
  });
});
