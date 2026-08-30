import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Clapperboard, Monitor, Tv, Users } from 'lucide-react';
import { api, type MediaServerWatchHistoryRow } from '@/lib/api';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { Pagination } from '@/components/ui/pagination';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 50;

function duration(seconds: number | null): string {
  if (seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * How a stream was delivered, as an operational signal rather than a word.
 *
 * This is the one column on the page with a cost attached: a direct play is
 * free, a direct stream remuxes, and a transcode occupies a CPU for the length
 * of the episode. Colour puts the expensive case in front of someone scanning
 * rather than making them read every row.
 */
const METHOD_VARIANT: Record<string, BadgeVariant> = {
  directplay: 'success',
  direct: 'success',
  directstream: 'info',
  copy: 'info',
  transcode: 'warning',
};

function methodVariant(method: string | null): BadgeVariant {
  if (!method) return 'outline';
  return METHOD_VARIANT[method.toLowerCase().replace(/[\s_-]/g, '')] ?? 'secondary';
}

/**
 * Completion decides the colour, because "watched" and "started" are different
 * facts and the old table showed them identically.
 *
 * Three bands rather than a gradient: finished, gave up partway, barely
 * started. An operator scanning for what people actually watch needs the
 * distinction, not a precise hue.
 */
function completion(pct: number | null) {
  if (pct == null) return { tone: 'bg-muted-foreground/30', label: null as string | null };
  if (pct >= 90) return { tone: 'bg-success', label: 'finished' };
  if (pct >= 25) return { tone: 'bg-warning', label: 'partial' };
  return { tone: 'bg-destructive/70', label: 'abandoned' };
}

/**
 * A stable colour per viewer, so a person can be followed down the page.
 *
 * Derived from the name rather than assigned, so the same viewer keeps their
 * colour across pages and reloads — a legend nobody has to read. Drawn from the
 * theme's own tokens, so it holds in both light and dark.
 */
const USER_TONES = [
  'bg-info/15 text-info',
  'bg-success/15 text-success',
  'bg-warning/15 text-warning',
  'bg-destructive/15 text-destructive',
  'bg-primary/15 text-primary',
];

function userTone(name: string | null): string {
  if (!name) return 'bg-muted text-muted-foreground';
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return USER_TONES[hash % USER_TONES.length];
}

export function WatchHistoryPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['mediaServerAnalytics', 'watch-history', page],
    queryFn: () => api.mediaServerAnalytics.watchHistory({ page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  const rows = q.data?.items ?? [];

  // Summary before detail: what this page of history amounts to, so the table
  // answers "what happened" rather than being the only thing that answers it.
  const summary = useMemo(() => {
    const viewers = new Set(rows.map((r) => r.userName).filter(Boolean));
    const seconds = rows.reduce((sum, r) => sum + (r.watchedSeconds ?? 0), 0);
    const known = rows.filter((r) => r.playbackMethod);
    const transcoded = known.filter((r) => /transcode/i.test(r.playbackMethod ?? ''));
    return {
      plays: rows.length,
      viewers: viewers.size,
      hours: Math.round(seconds / 360) / 10,
      transcodePct: known.length ? Math.round((transcoded.length / known.length) * 100) : null,
    };
  }, [rows]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('watchHistory.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('watchHistory.subtitle')}</p>
      </div>

      {q.isLoading ? (
        <CenteredSpinner />
      ) : q.isError ? (
        <ErrorState title={t('watchHistory.loadError')} onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('watchHistory.empty')} />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat icon={<Clapperboard className="h-4 w-4" />} label={t('watchHistory.summary.plays')} value={String(summary.plays)} />
            <Stat icon={<Users className="h-4 w-4" />} label={t('watchHistory.summary.viewers')} value={String(summary.viewers)} />
            <Stat icon={<Tv className="h-4 w-4" />} label={t('watchHistory.summary.hours')} value={`${summary.hours}`} />
            <Stat
              icon={<Monitor className="h-4 w-4" />}
              label={t('watchHistory.summary.transcoded')}
              value={summary.transcodePct == null ? '—' : `${summary.transcodePct}%`}
              tone={summary.transcodePct != null && summary.transcodePct >= 50 ? 'text-warning' : undefined}
            />
          </div>

          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-3 py-2 font-medium">{t('watchHistory.col.title')}</th>
                  <th className="px-3 py-2 font-medium">{t('watchHistory.col.user')}</th>
                  <th className="px-3 py-2 font-medium">{t('watchHistory.col.completion')}</th>
                  <th className="px-3 py-2 font-medium">{t('watchHistory.col.method')}</th>
                  <th className="hidden px-3 py-2 font-medium lg:table-cell">{t('watchHistory.col.device')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('watchHistory.col.watched')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('watchHistory.col.when')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => (
                  <Row key={h.id} h={h} t={t as unknown as (k: string, o?: Record<string, unknown>) => string} />
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={q.data?.total ?? 0} onPage={setPage} busy={q.isFetching} />
        </div>
      )}
    </div>
  );
}

function Stat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="text-muted-foreground/70">{icon}</span>
        {label}
      </div>
      <div className={cn('mt-0.5 text-xl font-semibold tabular-nums', tone)}>{value}</div>
    </div>
  );
}

function Row({ h, t }: { h: MediaServerWatchHistoryRow; t: (k: string, o?: Record<string, unknown>) => string }) {
  const bar = completion(h.percentComplete);
  const isEpisode = (h.mediaType ?? '').toLowerCase().includes('episode') || (h.mediaType ?? '').toLowerCase() === 'tv';

  return (
    <tr className="border-b border-border/60 last:border-0 hover:bg-muted/30">
      <td className="max-w-[22rem] px-3 py-2">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0 text-muted-foreground/70" aria-hidden>
            {isEpisode ? <Tv className="h-4 w-4" /> : <Clapperboard className="h-4 w-4" />}
          </span>
          <span className="min-w-0">
            {/* The title is the thing being scanned for; it earns the foreground. */}
            <span className="block truncate font-medium text-foreground">{h.title}</span>
            {h.libraryName && (
              <span className="block truncate text-xs text-muted-foreground">{h.libraryName}</span>
            )}
          </span>
        </div>
      </td>

      <td className="px-3 py-2">
        {h.userName ? (
          <span className={cn('inline-block rounded-full px-2 py-0.5 text-xs font-medium', userTone(h.userName))}>
            {h.userName}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>

      <td className="px-3 py-2">
        {h.percentComplete == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <div
            className="flex items-center gap-2"
            title={bar.label ? t(`watchHistory.completion.${bar.label}`) : undefined}
          >
            <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
              <span
                className={cn('block h-full rounded-full', bar.tone)}
                style={{ width: `${Math.min(100, Math.max(0, h.percentComplete))}%` }}
              />
            </span>
            <span className="tabular-nums text-xs text-muted-foreground">{Math.round(h.percentComplete)}%</span>
          </div>
        )}
      </td>

      <td className="px-3 py-2">
        {h.playbackMethod ? (
          <Badge variant={methodVariant(h.playbackMethod)}>{h.playbackMethod}</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>

      <td className="hidden max-w-[14rem] px-3 py-2 lg:table-cell">
        <span className="block truncate text-xs text-muted-foreground">
          {[h.device, h.client].filter(Boolean).join(' · ') || '—'}
        </span>
      </td>

      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{duration(h.watchedSeconds)}</td>

      {/* Relative to scan, exact on hover: "2h ago" answers the usual question,
          and the timestamp is there when it does not. */}
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground" title={formatDateTime(h.startedAt)}>
        {formatRelativeTime(h.startedAt)}
      </td>
    </tr>
  );
}
