import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { UseQueryResult } from '@tanstack/react-query';
import '@/i18n'; // initialise translations so t() returns real strings
import { ShowStatusPanel, showStatusIsInactive } from './ShowStatusPanel';
import type { ShowStatusResult } from '@/lib/api';

function result(over: Partial<ShowStatusResult>): ShowStatusResult {
  return {
    title: 'A Show',
    normalizedTitle: 'a show',
    provider: 'tmdb',
    providerShowId: '42',
    originalStatus: null,
    normalizedStatus: 'returning',
    recommendation: 'recommended',
    confidence: 0.95,
    firstAirDate: '2020-01-01',
    lastAirDate: null,
    nextEpisodeAirDate: null,
    lastEpisodeTitle: null,
    nextEpisodeTitle: null,
    totalSeasons: null,
    totalEpisodes: null,
    overview: null,
    posterUrl: null,
    warnings: [],
    ...over,
  };
}

const query = (data: ShowStatusResult) =>
  ({ isLoading: false, isFetching: false, isError: false, data, refetch: () => {} }) as unknown as UseQueryResult<ShowStatusResult>;

describe('ShowStatusPanel', () => {
  it('shows an ended show as not recommended with a backfill suggestion', () => {
    render(<ShowStatusPanel query={query(result({ normalizedStatus: 'ended', recommendation: 'not_recommended' }))} />);
    expect(screen.getByText('Ended')).toBeInTheDocument();
    expect(screen.getByText('Not recommended')).toBeInTheDocument();
    expect(screen.getByText(/backfill/i)).toBeInTheDocument();
  });

  it('shows a returning show as recommended', () => {
    render(<ShowStatusPanel query={query(result({ normalizedStatus: 'returning', recommendation: 'recommended' }))} />);
    expect(screen.getByText('Returning')).toBeInTheDocument();
    expect(screen.getByText('Recommended')).toBeInTheDocument();
    expect(screen.queryByText(/backfill/i)).not.toBeInTheDocument();
  });
});

describe('showStatusIsInactive', () => {
  it('is true only for ended/canceled', () => {
    expect(showStatusIsInactive('ended')).toBe(true);
    expect(showStatusIsInactive('canceled')).toBe(true);
    expect(showStatusIsInactive('returning')).toBe(false);
    expect(showStatusIsInactive(undefined)).toBe(false);
  });
});
