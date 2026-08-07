import {
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  CircleSlash,
  Loader2,
  ParkingCircle,
  Pause,
  SearchCheck,
  Sprout,
  Timer,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Namespace, TFunction } from 'i18next';
import { TorrentState, type TorrentParkingInfo } from '@ultratorrent/shared';
import { Badge, type BadgeProps } from '@/components/ui/badge';

interface StateMeta {
  /** i18n key under `torrents:state.*`. */
  key: string;
  variant: NonNullable<BadgeProps['variant']>;
  icon: React.ComponentType<{ className?: string }>;
  spin?: boolean;
}

export const STATE_META: Record<TorrentState, StateMeta> = {
  [TorrentState.DOWNLOADING]: { key: 'downloading', variant: 'info', icon: ArrowDownToLine },
  [TorrentState.SEEDING]: { key: 'seeding', variant: 'success', icon: Sprout },
  [TorrentState.COMPLETED]: { key: 'completed', variant: 'success', icon: CheckCircle2 },
  [TorrentState.PAUSED]: { key: 'paused', variant: 'warning', icon: Pause },
  [TorrentState.STOPPED]: { key: 'stopped', variant: 'secondary', icon: CircleSlash },
  [TorrentState.QUEUED]: { key: 'queued', variant: 'secondary', icon: Timer },
  [TorrentState.CHECKING]: { key: 'checking', variant: 'info', icon: SearchCheck, spin: false },
  [TorrentState.ALLOCATING]: { key: 'allocating', variant: 'info', icon: Loader2, spin: true },
  [TorrentState.ERROR]: { key: 'error', variant: 'destructive', icon: AlertTriangle },
  [TorrentState.UNKNOWN]: { key: 'unknown', variant: 'secondary', icon: CircleSlash },
};

/** Resolve the translated label for a torrent state (render-time). */
export function torrentStateLabel(t: TFunction<Namespace>, state: TorrentState): string {
  const meta = STATE_META[state] ?? STATE_META[TorrentState.UNKNOWN];
  return (t as unknown as (k: string) => string)(`state.${meta.key}`);
}

export function TorrentStateBadge({ state }: { state: TorrentState }) {
  const { t } = useTranslation('torrents');
  const meta = STATE_META[state] ?? STATE_META[TorrentState.UNKNOWN];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className="gap-1.5">
      <Icon className={meta.spin ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
      {torrentStateLabel(t, state)}
    </Badge>
  );
}

/**
 * "UltraTorrent parked this, and here is why."
 *
 * The engine reports a parked torrent as an ordinary `PAUSED`, identical to one
 * a person paused — so on a queue where most torrents are parked, the state
 * column truthfully says "paused" several hundred times and explains nothing.
 * This is the missing half: who stopped it, and on what evidence.
 *
 * Rendered ALONGSIDE the state badge rather than replacing it. The engine state
 * is still a fact, and hiding it would trade one incomplete story for another.
 */
export function TorrentParkedBadge({ parked }: { parked: TorrentParkingInfo }) {
  const { t } = useTranslation('torrents');
  const tr = t as unknown as (k: string, o?: Record<string, unknown>) => string;
  // The reason is an open vocabulary from the parking service; an unrecognised
  // one falls back to the raw code rather than rendering a missing-key string.
  const reason = tr(`parking.reason.${parked.reason}`, { defaultValue: parked.reason });

  return (
    <Badge
      variant="outline"
      className="gap-1.5"
      title={tr('parking.tooltip', {
        reason,
        seeders: parked.lastSeeders,
        probes: parked.probeCount,
      })}
    >
      <ParkingCircle className={parked.probing ? 'h-3 w-3 animate-pulse' : 'h-3 w-3'} />
      {parked.probing ? tr('parking.probing') : tr('parking.parked')}
    </Badge>
  );
}

/** Compact status pill (icon only) for dense table rows. */
export function TorrentStateDot({ state }: { state: TorrentState }) {
  const { t } = useTranslation('torrents');
  const meta = STATE_META[state] ?? STATE_META[TorrentState.UNKNOWN];
  const Icon = meta.icon;
  const color: Record<NonNullable<BadgeProps['variant']>, string> = {
    default: 'text-primary',
    secondary: 'text-muted-foreground',
    success: 'text-success',
    warning: 'text-warning',
    destructive: 'text-destructive',
    info: 'text-info',
    outline: 'text-foreground',
  };
  return (
    <span className="inline-flex items-center" title={torrentStateLabel(t, state)}>
      <Icon className={`h-4 w-4 ${color[meta.variant]} ${meta.spin ? 'animate-spin' : ''}`} />
    </span>
  );
}

/**
 * The parked marker for dense table rows.
 *
 * Icon-only, matching {@link TorrentStateDot}, because the row is deliberately
 * one line high: the table comment notes that anything which changes row height
 * shows up as the list "breathing" on every live update. A full badge here
 * would do exactly that on the several hundred rows that are parked.
 */
export function TorrentParkedDot({ parked }: { parked: TorrentParkingInfo }) {
  const { t } = useTranslation('torrents');
  const tr = t as unknown as (k: string, o?: Record<string, unknown>) => string;
  const reason = tr(`parking.reason.${parked.reason}`, { defaultValue: parked.reason });
  return (
    <span
      className="inline-flex items-center"
      title={tr('parking.tooltip', {
        reason,
        seeders: parked.lastSeeders,
        probes: parked.probeCount,
      })}
    >
      <ParkingCircle
        className={`h-4 w-4 text-muted-foreground ${parked.probing ? 'animate-pulse' : ''}`}
      />
    </span>
  );
}
