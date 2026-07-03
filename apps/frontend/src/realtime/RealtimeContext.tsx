import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  WS_EVENTS,
  type GlobalStats,
  type NormalizedTorrent,
} from '@ultratorrent/shared';
import { wsClient, type WsStatus } from '@/lib/ws';

export interface BandwidthSample {
  /** Epoch ms. */
  t: number;
  /** Clock label for the X axis. */
  label: string;
  down: number;
  up: number;
}

type TorrentsListener = (torrents: NormalizedTorrent[]) => void;

interface RealtimeContextValue {
  status: WsStatus;
  stats: GlobalStats | null;
  /** Rolling window of bandwidth samples for charting. */
  bandwidth: BandwidthSample[];
  engineOnline: boolean | null;
  engineError: string | null;
  /** Subscribe to live torrent snapshots pushed by the gateway. */
  subscribeTorrents: (listener: TorrentsListener) => () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

const MAX_SAMPLES = 60;

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<WsStatus>(wsClient.connectionStatus);
  const [stats, setStats] = useState<GlobalStats | null>(null);
  const [bandwidth, setBandwidth] = useState<BandwidthSample[]>([]);
  const [engineOnline, setEngineOnline] = useState<boolean | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);

  // Torrent listeners are kept in a ref so high-frequency pushes don't re-render
  // every consumer of this provider — only subscribers receive the data.
  const torrentListeners = useRef(new Set<TorrentsListener>());

  useEffect(() => {
    const offStatus = wsClient.onStatus(setStatus);

    const offStats = wsClient.on(WS_EVENTS.STATS_UPDATE, (payload) => {
      setStats(payload.stats);
      const now = Date.now();
      setBandwidth((prev) => {
        const sample: BandwidthSample = {
          t: now,
          label: new Date(now).toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
          down: payload.stats.downloadRate,
          up: payload.stats.uploadRate,
        };
        const next = [...prev, sample];
        return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next;
      });
    });

    const offEngine = wsClient.on(WS_EVENTS.ENGINE_STATUS, (payload) => {
      setEngineOnline(payload.online);
      setEngineError(payload.error);
    });

    const offTorrents = wsClient.on(WS_EVENTS.TORRENTS_UPDATE, (payload) => {
      for (const listener of torrentListeners.current) listener(payload.torrents);
    });

    return () => {
      offStatus();
      offStats();
      offEngine();
      offTorrents();
    };
  }, []);

  const value = useMemo<RealtimeContextValue>(
    () => ({
      status,
      stats,
      bandwidth,
      engineOnline,
      engineError,
      subscribeTorrents: (listener) => {
        torrentListeners.current.add(listener);
        return () => torrentListeners.current.delete(listener);
      },
    }),
    [status, stats, bandwidth, engineOnline, engineError],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useRealtime must be used within <RealtimeProvider>');
  return ctx;
}

/** Subscribe to live torrent snapshots with automatic cleanup. */
export function useTorrentStream(listener: (torrents: NormalizedTorrent[]) => void): void {
  const { subscribeTorrents } = useRealtime();
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    return subscribeTorrents((torrents) => ref.current(torrents));
  }, [subscribeTorrents]);
}
