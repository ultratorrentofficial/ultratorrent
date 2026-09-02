import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';

vi.mock('@/lib/api', () => ({ api: { mediaServerAnalytics: { recentlyAdded: vi.fn() } } }));
vi.mock('@/components/media/MediaPoster', () => ({
  MediaPoster: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

import { api } from '@/lib/api';
import { RecentlyAddedPage } from './RecentlyAddedPage';

const item = (over: Record<string, unknown> = {}) => ({
  id: 'i1', title: 'Dune: Part Two', mediaType: 'movie', year: 2024,
  season: null, episode: null, addedAt: new Date().toISOString(),
  libraryName: 'Movies', poster: null, ...over,
});

function renderPage(items: Record<string, unknown>[]) {
  vi.mocked(api.mediaServerAnalytics.recentlyAdded).mockResolvedValue(items as never);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RecentlyAddedPage />
    </QueryClientProvider>,
  );
}

describe('Recently Added', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * The library is the point of the column: a title alone does not say whether a
   * film landed in Movies or Animated Movies, which is the mistake this list is
   * scanned for.
   */
  it('shows the library each item landed in', async () => {
    renderPage([item({ libraryName: 'Animated Movies' })]);
    await screen.findByText('Animated Movies');
  });

  it('says so plainly when an item has no library', async () => {
    renderPage([item({ libraryName: null })]);
    await screen.findByText(/no library/i);
  });

  it('renders the poster it was already given', async () => {
    renderPage([item()]);
    await screen.findByAltText('Dune: Part Two');
  });

  it('shows a season/episode label only for episodes', async () => {
    renderPage([item({ mediaType: 'tv', title: 'The Rookie', season: 2, episode: 5 })]);
    await screen.findByText('S02E05');
  });

  it('offers a library filter only when there is more than one', async () => {
    renderPage([item({ id: 'a', libraryName: 'Movies' })]);
    await screen.findByText('Dune: Part Two');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('filters by library once several exist', async () => {
    renderPage([
      item({ id: 'a', title: 'Film A', libraryName: 'Movies' }),
      item({ id: 'b', title: 'Film B', libraryName: 'Animated Movies' }),
    ]);
    await screen.findByText('Film A');
    expect(screen.getByRole('combobox')).toBeTruthy();
  });
});
