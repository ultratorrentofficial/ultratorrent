import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';

vi.mock('@/lib/api', () => ({
  api: { mediaServerAnalytics: { watchHistory: vi.fn() } },
}));

import { api } from '@/lib/api';
import { WatchHistoryPage } from './WatchHistoryPage';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1', userName: 'alice', title: 'The Wolf Boy', mediaType: 'episode',
  libraryName: 'TV Retro', device: 'Living Room TV', client: 'Plex for Apple TV',
  startedAt: new Date(Date.now() - 3600_000).toISOString(), stoppedAt: null,
  watchedSeconds: 2400, percentComplete: 96, playbackMethod: 'directplay',
  importSource: 'live', ...over,
});

function renderPage(items: Record<string, unknown>[]) {
  vi.mocked(api.mediaServerAnalytics.watchHistory).mockResolvedValue(
    { items, total: items.length, page: 1, pageSize: 50 } as never,
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WatchHistoryPage />
    </QueryClientProvider>,
  );
}

describe('WatchHistoryPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('leads with what the page amounts to, before the rows', async () => {
    renderPage([row(), row({ id: 'r2', userName: 'bob', playbackMethod: 'transcode' })]);
    await waitFor(() => expect(screen.getByText('Plays')).toBeTruthy());
    expect(screen.getByText('Viewers')).toBeTruthy();
    // two plays, two distinct viewers, half of them transcoded
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('shows the title in the foreground with its library beneath', async () => {
    renderPage([row()]);
    await waitFor(() => expect(screen.getByText('The Wolf Boy')).toBeTruthy());
    expect(screen.getByText('TV Retro')).toBeTruthy();
  });

  /*
   * The distinction the old table could not make: a play that finished and a
   * play abandoned after two minutes looked identical.
   */
  it('separates a finished watch from an abandoned one', async () => {
    renderPage([
      row({ id: 'done', percentComplete: 98 }),
      row({ id: 'gaveup', percentComplete: 4 }),
    ]);
    await waitFor(() => expect(screen.getByText('98%')).toBeTruthy());
    expect(screen.getByText('4%')).toBeTruthy();
    expect(screen.getByTitle('Watched to the end')).toBeTruthy();
    expect(screen.getByTitle('Barely started')).toBeTruthy();
  });

  it('surfaces the device and client the old page dropped entirely', async () => {
    renderPage([row()]);
    await waitFor(() => expect(screen.getByText(/Living Room TV · Plex for Apple TV/)).toBeTruthy());
  });

  it('copes with a row that knows almost nothing', async () => {
    renderPage([row({
      id: 'sparse', userName: null, libraryName: null, device: null, client: null,
      percentComplete: null, playbackMethod: null, watchedSeconds: null,
    })]);
    await waitFor(() => expect(screen.getByText('The Wolf Boy')).toBeTruthy());
    // Absent values read as absent, never as zero or as a broken bar.
    expect(screen.getAllByText('—').length).toBeGreaterThan(2);
  });
});
