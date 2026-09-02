import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';

vi.mock('@/lib/api', () => ({
  api: { mediaServerAnalytics: { watchHistory: vi.fn(), dashboard: vi.fn() } },
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

function renderPage(items: Record<string, unknown>[], connections: unknown[] = []) {
  vi.mocked(api.mediaServerAnalytics.dashboard).mockResolvedValue({ connections } as never);
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

const conn = (id: string, name: string, kind = 'plex') => ({
  id, name, kind, enabled: true, isDefault: false, status: 'online',
  serverVersion: null, platform: null, capabilities: {},
  lastHealthCheckAt: null, lastRefreshAt: null, notes: null,
});

/**
 * With two servers attached, a play with no attribution is ambiguous. With one,
 * the label is on every row and says nothing — so it appears only above one.
 */
describe('watch history server attribution', () => {
  it('names the server when two are connected', async () => {
    renderPage(
      [row({ connectionId: 'c-jf' })],
      [conn('c-plex', 'SYNOPLEX'), conn('c-jf', 'SYNOPLEX-JELLYFIN', 'jellyfin')],
    );
    await screen.findByText('SYNOPLEX-JELLYFIN');
  });

  it('stays quiet with a single server', async () => {
    renderPage([row({ connectionId: 'c-plex' })], [conn('c-plex', 'SYNOPLEX')]);
    await screen.findByText('The Wolf Boy');
    expect(screen.queryByText('SYNOPLEX')).toBeNull();
  });

  it('leaves imported history unlabelled — it came from no server', async () => {
    renderPage(
      [row({ connectionId: null, importSource: 'tautulli' })],
      [conn('c-plex', 'SYNOPLEX'), conn('c-jf', 'JF', 'jellyfin')],
    );
    await screen.findByText('The Wolf Boy');
    expect(screen.queryByText('SYNOPLEX')).toBeNull();
  });
});
