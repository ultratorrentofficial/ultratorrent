import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';

vi.mock('@/lib/api', () => ({
  api: { mediaServerAnalytics: { live: vi.fn(), dashboard: vi.fn() } },
}));
vi.mock('@/lib/ws', () => ({ wsClient: { on: () => () => {}, off: () => {} } }));
vi.mock('@/realtime/RealtimeContext', () => ({ useRealtime: () => ({ connected: true }) }));

import { api } from '@/lib/api';
import { LiveActivityPage } from './LiveActivityPage';

const session = (over: Record<string, unknown> = {}) => ({
  id: 's1', connectionId: 'c-plex', userName: 'alice', userDisplayName: 'Alice',
  title: 'Population: Zero', mediaType: 'episode', libraryName: 'TV Retro',
  device: 'Living Room TV', client: 'Plex', playbackState: 'playing',
  progressPercent: 40, playbackMethod: 'directplay', hasArtwork: false,
  showTitle: null, seasonNumber: null, episodeNumber: null, year: null,
  resolution: null, videoCodec: null, bitrateKbps: null, container: null, ...over,
});

const conn = (id: string, name: string, kind: string) => ({
  id, name, kind, enabled: true, isDefault: false, status: 'online',
  serverVersion: null, platform: null, capabilities: {},
  lastHealthCheckAt: null, lastRefreshAt: null, notes: null,
});

function renderPage(sessions: unknown[], connections: unknown[]) {
  vi.mocked(api.mediaServerAnalytics.live).mockResolvedValue(sessions as never);
  vi.mocked(api.mediaServerAnalytics.dashboard).mockResolvedValue({ connections } as never);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <LiveActivityPage />
    </QueryClientProvider>,
  );
}

/**
 * Which server a session is playing on only matters once more than one is
 * attached. Plex and Jellyfin on the same host is exactly when "someone is
 * watching something" stops being enough information.
 */
describe('Live Activity server labelling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names the server when two are connected', async () => {
    renderPage(
      [session({ connectionId: 'c-jf' })],
      [conn('c-plex', 'SYNOPLEX', 'plex'), conn('c-jf', 'SYNOPLEX-JELLYFIN', 'jellyfin')],
    );
    await screen.findByText('SYNOPLEX-JELLYFIN');
  });

  it('attributes each session to its own server', async () => {
    renderPage(
      [session({ id: 's1', connectionId: 'c-plex' }), session({ id: 's2', connectionId: 'c-jf' })],
      [conn('c-plex', 'SYNOPLEX', 'plex'), conn('c-jf', 'SYNOPLEX-JELLYFIN', 'jellyfin')],
    );
    await screen.findByText('SYNOPLEX');
    await screen.findByText('SYNOPLEX-JELLYFIN');
  });

  it('stays quiet with a single server, where the label tells nobody anything', async () => {
    renderPage([session()], [conn('c-plex', 'SYNOPLEX', 'plex')]);
    await screen.findByText(/Population: Zero/);
    expect(screen.queryByText('SYNOPLEX')).toBeNull();
  });

  it('does not break on a session whose connection is gone', async () => {
    renderPage([session({ connectionId: 'deleted' })], [conn('c-plex', 'A', 'plex'), conn('c-jf', 'B', 'jellyfin')]);
    await screen.findByText(/Population: Zero/);
  });
});
