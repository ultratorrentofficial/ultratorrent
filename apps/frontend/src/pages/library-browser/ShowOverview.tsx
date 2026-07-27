import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import type { ShowHealth } from '@/lib/api';
import { Skeleton } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { HealthBadge } from './HealthBadge';

/** Bytes → a short human string. Binary units, because storage tools report those. */
export function formatBytes(raw: string | number): string {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 10 (4.6 GB reads better than 5 GB); none above.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * What is worth fixing, ordered by how much of it there is.
 *
 * Summing the per-season counts rather than re-deriving from episodes: the
 * service already grouped them, and a second aggregation is a second thing that
 * can disagree with the badges.
 */
export function aggregateReasons(health: ShowHealth): Array<{ reason: string; count: number }> {
  const totals: Record<string, number> = {};
  for (const season of health.seasons) {
    for (const [reason, count] of Object.entries(season.reasonCounts)) {
      totals[reason] = (totals[reason] ?? 0) + count;
    }
  }
  return Object.entries(totals)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/**
 * The show at a glance.
 *
 * Deliberately shows only what the platform can answer today. Watched counts,
 * play totals and completion percentages are absent because
 * `media_playback_aggregates` is empty and `MediaUserWatch` has no foreign key
 * to a media item — rendering those as `0` would report "never watched" for a
 * show someone has watched, which is worse than not showing them.
 */
export function ShowOverview({ health, loading }: { health: ShowHealth | null; loading: boolean }) {
  const { t } = useTranslation('media');
  const reasons = useMemo(() => (health ? aggregateReasons(health) : []), [health]);

  if (loading || !health) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
      </div>
    );
  }

  const tiles = [
    { label: t('overview.seasons'), value: String(health.totals.seasons) },
    { label: t('overview.episodes'), value: String(health.totals.episodes) },
    { label: t('overview.storage'), value: formatBytes(health.totals.bytes) },
  ];

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{tile.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{tile.value}</p>
          </div>
        ))}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('health.showScore')}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <p className="text-2xl font-semibold tabular-nums">
              {health.status === 'unknown' ? '—' : health.score}
            </p>
            <HealthBadge score={health.score} status={health.status} showScore={false} />
          </div>
        </div>
      </div>

      <section>
        <h3 className="mb-2 text-sm font-medium">{t('overview.whatToFix')}</h3>
        {!reasons.length ? (
          <p className="text-sm text-muted-foreground">{t('overview.nothingToFix')}</p>
        ) : (
          <ul className="space-y-1.5">
            {reasons.map(({ reason, count }) => {
              const share = health.totals.episodes
                ? Math.round((count / health.totals.episodes) * 100)
                : 0;
              return (
                <li key={reason} className="flex items-center gap-3">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-300/70" aria-hidden />
                  <span className="w-56 shrink-0 truncate text-sm">
                    {t(`health.reason.${reason}` as 'health.reason.unmatched')}
                  </span>
                  {/* The bar is proportion; the number is the fact. */}
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
                    <span
                      className={cn('block h-full rounded-full bg-amber-400/50')}
                      style={{ width: `${Math.max(2, share)}%` }}
                    />
                  </span>
                  <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {t('overview.episodeShare', { count, share })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
