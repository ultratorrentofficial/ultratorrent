import type { BadgeVariant } from '@/components/ui/badge';
import type { PlatformJobStatus } from '@/lib/api';

/** Badge tone for a job status. */
export function statusVariant(s: PlatformJobStatus): BadgeVariant {
  switch (s) {
    case 'running':
    case 'pausing':
    case 'cancelling':
      return 'info';
    case 'completed':
      return 'success';
    case 'completed_with_warnings':
    case 'paused':
    case 'retrying':
      return 'warning';
    case 'failed':
      return 'destructive';
    default:
      return 'secondary'; // scheduled/queued/waiting/blocked/cancelled/skipped/expired
  }
}

/** The status views exposed as tabs (each maps to a single-status filter). */
export const JOB_TABS: { key: string; status?: PlatformJobStatus }[] = [
  { key: 'all' },
  { key: 'running', status: 'running' },
  { key: 'queued', status: 'queued' },
  { key: 'waiting', status: 'waiting' },
  { key: 'scheduled', status: 'scheduled' },
  { key: 'failed', status: 'failed' },
  { key: 'completed', status: 'completed' },
  { key: 'cancelled', status: 'cancelled' },
];

/** A short human duration between two ISO timestamps (or now). */
export function jobDuration(start?: string | null, end?: string | null): string {
  if (!start) return '—';
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const ms = Math.max(0, e - s);
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}
