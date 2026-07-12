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

/**
 * The backend syncs every engine on one 2s tick and broadcasts a separate
 * `stats:update` per engine, back-to-back. Samples that land inside this window
 * therefore belong to the *same* sync round and must collapse into one chart
 * point — otherwise a two-engine setup plots twice as many points as it should.
 * Must stay below the backend's sync interval (TorrentSyncService, 2000ms).
 */
const SAME_ROUND_MS = 1000;

/**
 * Fold every engine's stats into the one figure the dashboard actually wants:
 * the total across all of them.
 *
 * Rate *limits* are not summed blindly — 0 means "unlimited", so one unbounded
 * engine makes the whole aggregate unbounded.
 */
function aggregate(perEngine: Iterable<GlobalStats>): GlobalStats {
  const all = [...perEngine];
  const sum = (pick: (s: GlobalStats) => number) =>
    all.reduce((total, s) => total + pick(s), 0);
  const limit = (pick: (s: GlobalStats) => number) =>
    all.some((s) => pick(s) === 0) ? 0 : sum(pick);

  return {
    downloadRate: sum((s) => s.downloadRate),
    uploadRate: sum((s) => s.uploadRate),
    downloadRateLimit: limit((s) => s.downloadRateLimit),
    uploadRateLimit: limit((s) => s.uploadRateLimit),
    totalDownloaded: sum((s) => s.totalDownloaded),
    totalUploaded: sum((s) => s.totalUploaded),
    torrentCount: sum((s) => s.torrentCount),
    activeCount: sum((s) => s.activeCount),
  };
}

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<WsStatus>(wsClient.connectionStatus);
  const [stats, setStats] = useState<GlobalStats | null>(null);
  const [bandwidth, setBandwidth] = useState<BandwidthSample[]>([]);
  const [engineOnline, setEngineOnline] = useState<boolean | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);

  // Every engine reports independently, so the latest event from ONE engine is
  // not the state of the system. Keep the last report per engine and derive the
  // totals from all of them — otherwise the last engine to broadcast overwrites
  // the others, and an idle engine's 0 B/s erases an active engine's real rate
  // twice a second.
  const statsByEngine = useRef(new Map<string, GlobalStats>());
  const statusByEngine = useRef(new Map<string, { online: boolean; error: string | null }>());

  // Torrent listeners are kept in a ref so high-frequency pushes don't re-render
  // every consumer of this provider — only subscribers receive the data.
  const torrentListeners = useRef(new Set<TorrentsListener>());

  useEffect(() => {
    const offStatus = wsClient.onStatus(setStatus);

    const offStats = wsClient.on(WS_EVENTS.STATS_UPDATE, (payload) => {
      statsByEngine.current.set(payload.engineId, payload.stats);
      const totals = aggregate(statsByEngine.current.values());
      setStats(totals);

      const now = Date.now();
      setBandwidth((prev) => {
        const sample: BandwidthSample = {
          t: now,
          label: new Date(now).toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
          down: totals.downloadRate,
          up: totals.uploadRate,
        };

        // Later engines in the same sync round refine this round's total rather
        // than adding a point of their own.
        const last = prev[prev.length - 1];
        const next =
          last && now - last.t < SAME_ROUND_MS
            ? [...prev.slice(0, -1), sample]
            : [...prev, sample];

        return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next;
      });
    });

    const offEngine = wsClient.on(WS_EVENTS.ENGINE_STATUS, (payload) => {
      statusByEngine.current.set(payload.engineId, {
        online: payload.online,
        error: payload.error,
      });
      const all = [...statusByEngine.current.values()];

      // A global badge: the system is reachable if any engine is. Without this,
      // one offline engine flips the badge to Offline on every sync tick.
      setEngineOnline(all.some((e) => e.online));
      setEngineError(all.find((e) => !e.online && e.error)?.error ?? null);
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
