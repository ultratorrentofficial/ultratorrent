import {
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  CircleSlash,
  Loader2,
  Pause,
  SearchCheck,
  Sprout,
  Timer,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Namespace, TFunction } from 'i18next';
import { TorrentState } from '@ultratorrent/shared';
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
