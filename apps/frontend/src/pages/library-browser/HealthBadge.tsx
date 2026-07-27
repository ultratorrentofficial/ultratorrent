import { useTranslation } from 'react-i18next';
import type { HealthStatus } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Colour carries the status; the number carries the detail.
 *
 * Never colour alone — a red dot and an amber dot are the same dot to a
 * colour-blind operator, so every badge also states its score, and the
 * accessible name spells the status out.
 */
const TONE: Record<HealthStatus, string> = {
  healthy: 'bg-emerald-400/15 text-emerald-300 border-emerald-400/30',
  attention: 'bg-amber-400/15 text-amber-200 border-amber-400/30',
  problem: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  // Grey, and deliberately not green: "nothing to score" is not "all good".
  unknown: 'bg-white/5 text-muted-foreground border-white/10',
};

export function HealthBadge({
  score, status, reasons, className, showScore = true,
}: {
  score: number;
  status: HealthStatus;
  /** Reason keys, rendered as a tooltip so the badge explains itself. */
  reasons?: string[];
  className?: string;
  showScore?: boolean;
}) {
  const { t } = useTranslation('media');
  const label = t(`health.status.${status}` as 'health.status.healthy');
  const detail = reasons?.length
    ? reasons.map((r) => t(`health.reason.${r}` as 'health.reason.unmatched')).join(' · ')
    : label;

  return (
    <span
      title={detail}
      aria-label={`${label} — ${score}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium',
        TONE[status], className,
      )}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {showScore && (status === 'unknown' ? '—' : score)}
    </span>
  );
}
