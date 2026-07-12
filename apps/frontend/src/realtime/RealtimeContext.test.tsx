import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { WS_EVENTS, type GlobalStats } from '@ultratorrent/shared';
import { RealtimeProvider, useRealtime } from './RealtimeContext';

/**
 * The backend broadcasts one `stats:update` per engine on a single sync tick.
 * These tests pin the behaviour that a multi-engine setup broke: the provider
 * must combine the engines, not let the last one to speak overwrite the rest.
 */

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

const emit = (event: string, payload: unknown) =>
  act(() => {
    for (const h of handlers.get(event) ?? []) h(payload);
  });

vi.mock('@/lib/ws', () => ({
  wsClient: {
    connectionStatus: 'connected',
    onStatus: () => () => {},
    on: (event: string, handler: Handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => handlers.get(event)!.delete(handler);
    },
  },
}));

const stats = (over: Partial<GlobalStats> = {}): GlobalStats => ({
  downloadRate: 0,
  uploadRate: 0,
  downloadRateLimit: 0,
  uploadRateLimit: 0,
  totalDownloaded: 0,
  totalUploaded: 0,
  torrentCount: 0,
  activeCount: 0,
  ...over,
});

function Probe() {
  const { stats: s, bandwidth, engineOnline } = useRealtime();
  return (
    <div>
      <span data-testid="down">{s?.downloadRate ?? 'null'}</span>
      <span data-testid="up">{s?.uploadRate ?? 'null'}</span>
      <span data-testid="torrents">{s?.torrentCount ?? 'null'}</span>
      <span data-testid="dl-limit">{s?.downloadRateLimit ?? 'null'}</span>
      <span data-testid="samples">{bandwidth.length}</span>
      <span data-testid="last-down">{bandwidth[bandwidth.length - 1]?.down ?? 'none'}</span>
      <span data-testid="online">{String(engineOnline)}</span>
    </div>
  );
}

const renderProbe = () =>
  render(
    <RealtimeProvider>
      <Probe />
    </RealtimeProvider>,
  );

const at = new Date().toISOString();

describe('RealtimeProvider — multiple engines', () => {
  beforeEach(() => handlers.clear());

  it('sums the engines instead of letting the last one overwrite the others', () => {
    renderProbe();

    // One sync round: an active qBittorrent, then an idle rTorrent.
    emit(WS_EVENTS.STATS_UPDATE, {
      engineId: 'qbit',
      at,
      stats: stats({ downloadRate: 5_000_000, uploadRate: 1_000, torrentCount: 3 }),
    });
    emit(WS_EVENTS.STATS_UPDATE, {
      engineId: 'rtorrent',
      at,
      stats: stats({ downloadRate: 0, uploadRate: 0, torrentCount: 2 }),
    });

    // Previously the idle engine's 0 clobbered the active one — the counter
    // flashed a number and fell back to a dash on every tick.
    expect(screen.getByTestId('down').textContent).toBe('5000000');
    expect(screen.getByTestId('up').textContent).toBe('1000');
    expect(screen.getByTestId('torrents').textContent).toBe('5');
  });

  it('plots one chart point per sync round, not one per engine', () => {
    renderProbe();

    emit(WS_EVENTS.STATS_UPDATE, {
      engineId: 'qbit',
      at,
      stats: stats({ downloadRate: 4_000 }),
    });
    emit(WS_EVENTS.STATS_UPDATE, {
      engineId: 'rtorrent',
      at,
      stats: stats({ downloadRate: 1_000 }),
    });

    expect(screen.getByTestId('samples').textContent).toBe('1');
    // ...and that single point carries the combined rate.
    expect(screen.getByTestId('last-down').textContent).toBe('5000');
  });

  it('keeps the badge online while any engine is up', () => {
    renderProbe();

    emit(WS_EVENTS.ENGINE_STATUS, { engineId: 'qbit', online: true, error: null, at });
    emit(WS_EVENTS.ENGINE_STATUS, {
      engineId: 'rtorrent',
      online: false,
      error: 'connect ECONNREFUSED',
      at,
    });

    // The offline engine used to flip the whole badge to Offline every 2s.
    expect(screen.getByTestId('online').textContent).toBe('true');
  });

  it('reports offline only when every engine is down', () => {
    renderProbe();

    emit(WS_EVENTS.ENGINE_STATUS, { engineId: 'qbit', online: false, error: 'down', at });
    emit(WS_EVENTS.ENGINE_STATUS, { engineId: 'rtorrent', online: false, error: 'down', at });

    expect(screen.getByTestId('online').textContent).toBe('false');
  });

  it('treats an unlimited engine as making the aggregate limit unlimited', () => {
    renderProbe();

    emit(WS_EVENTS.STATS_UPDATE, {
      engineId: 'capped',
      at,
      stats: stats({ downloadRateLimit: 1_000_000 }),
    });
    emit(WS_EVENTS.STATS_UPDATE, {
      engineId: 'uncapped',
      at,
      stats: stats({ downloadRateLimit: 0 }), // 0 = unlimited
    });

    // Summing would have reported a 1 MB/s ceiling that does not actually exist.
    expect(screen.getByTestId('dl-limit').textContent).toBe('0');
  });
});
