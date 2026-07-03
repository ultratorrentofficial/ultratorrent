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
import { TorrentState } from '@ultratorrent/shared';
import { Badge, type BadgeProps } from '@/components/ui/badge';

interface StateMeta {
  label: string;
  variant: NonNullable<BadgeProps['variant']>;
  icon: React.ComponentType<{ className?: string }>;
  spin?: boolean;
}

export const STATE_META: Record<TorrentState, StateMeta> = {
  [TorrentState.DOWNLOADING]: { label: 'Downloading', variant: 'info', icon: ArrowDownToLine },
  [TorrentState.SEEDING]: { label: 'Seeding', variant: 'success', icon: Sprout },
  [TorrentState.COMPLETED]: { label: 'Completed', variant: 'success', icon: CheckCircle2 },
  [TorrentState.PAUSED]: { label: 'Paused', variant: 'warning', icon: Pause },
  [TorrentState.STOPPED]: { label: 'Stopped', variant: 'secondary', icon: CircleSlash },
  [TorrentState.QUEUED]: { label: 'Queued', variant: 'secondary', icon: Timer },
  [TorrentState.CHECKING]: { label: 'Checking', variant: 'info', icon: SearchCheck, spin: false },
  [TorrentState.ALLOCATING]: { label: 'Allocating', variant: 'info', icon: Loader2, spin: true },
  [TorrentState.ERROR]: { label: 'Error', variant: 'destructive', icon: AlertTriangle },
  [TorrentState.UNKNOWN]: { label: 'Unknown', variant: 'secondary', icon: CircleSlash },
};

export function TorrentStateBadge({ state }: { state: TorrentState }) {
  const meta = STATE_META[state] ?? STATE_META[TorrentState.UNKNOWN];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className="gap-1.5">
      <Icon className={meta.spin ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
      {meta.label}
    </Badge>
  );
}

/** Compact status pill (icon only) for dense table rows. */
export function TorrentStateDot({ state }: { state: TorrentState }) {
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
    <span className="inline-flex items-center" title={meta.label}>
      <Icon className={`h-4 w-4 ${color[meta.variant]} ${meta.spin ? 'animate-spin' : ''}`} />
    </span>
  );
}
