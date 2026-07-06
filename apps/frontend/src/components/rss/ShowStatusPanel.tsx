import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CalendarClock, RefreshCw, Tv } from 'lucide-react';
import {
  api,
  type RssShowRecommendation,
  type RssShowStatus,
  type ShowStatusResult,
} from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CenteredSpinner, ErrorState } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';

type BadgeVariant = 'success' | 'warning' | 'destructive' | 'info' | 'secondary' | 'outline';

const STATUS_VARIANT: Record<RssShowStatus, BadgeVariant> = {
  continuing: 'success',
  returning: 'success',
  planned: 'info',
  on_hiatus: 'warning',
  ended: 'secondary',
  canceled: 'destructive',
  unknown: 'outline',
};

const REC_VARIANT: Record<RssShowRecommendation, BadgeVariant> = {
  recommended: 'success',
  caution: 'warning',
  not_recommended: 'destructive',
  unknown: 'outline',
};

/** Look up a show's airing status, keyed by title+year. Disabled until a title. */
export function useShowStatusLookup(title: string, year: number | null, enabled: boolean) {
  const key = title.trim();
  return useQuery<ShowStatusResult>({
    queryKey: ['rss', 'show-status', key.toLowerCase(), year ?? null],
    queryFn: () => api.rss.showStatusLookup(key, { year }),
    enabled: enabled && key.length > 1,
    staleTime: 5 * 60_000,
  });
}

export function ShowStatusBadge({ status }: { status: RssShowStatus }) {
  const { t } = useTranslation('rss');
  return (
    <Badge variant={STATUS_VARIANT[status]} dot>
      {t(`showStatus.status.${status}` as 'showStatus.status.unknown')}
    </Badge>
  );
}

function fmt(date: string | null): string | null {
  if (!date) return null;
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString();
}

/**
 * Airing-status panel for the RSS rule / smart-match flow: status badge,
 * recommendation banner, provider confidence, next/last episode dates, poster,
 * warnings, and a refresh button. Presentational — pass the query from
 * `useShowStatusLookup`.
 */
export function ShowStatusPanel({ query }: { query: UseQueryResult<ShowStatusResult> }) {
  const { t } = useTranslation('rss');

  if (query.isLoading || (query.isFetching && !query.data)) {
    return (
      <div className="rounded-lg border border-border/60 p-4">
        <CenteredSpinner label={t('showStatus.checking')} />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="rounded-lg border border-border/60 p-4">
        <ErrorState message={t('showStatus.lookupError')} onRetry={() => query.refetch()} />
      </div>
    );
  }
  const r = query.data;
  if (!r) return null;

  const bannerTone: Record<RssShowRecommendation, string> = {
    recommended: 'border-success/30 bg-success/5',
    caution: 'border-warning/30 bg-warning/5',
    not_recommended: 'border-destructive/30 bg-destructive/5',
    unknown: 'border-border/60',
  };
  const nextDate = fmt(r.nextEpisodeAirDate);
  const lastDate = fmt(r.lastAirDate);

  return (
    <div className={cn('space-y-3 rounded-lg border p-4', bannerTone[r.recommendation])}>
      <div className="flex items-start gap-3">
        {r.posterUrl ? (
          <img
            src={r.posterUrl}
            alt={r.title}
            className="h-[4.5rem] w-12 shrink-0 rounded object-cover ring-1 ring-white/10"
            loading="lazy"
          />
        ) : (
          <div className="grid h-[4.5rem] w-12 shrink-0 place-items-center rounded bg-white/[0.04] text-muted-foreground ring-1 ring-white/5">
            <Tv className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <ShowStatusBadge status={r.normalizedStatus} />
            <Badge variant={REC_VARIANT[r.recommendation]}>
              {t(`showStatus.recommendation.${r.recommendation}` as 'showStatus.recommendation.unknown')}
            </Badge>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => query.refetch()}
              loading={query.isFetching}
              title={t('showStatus.refresh')}
            >
              <RefreshCw className="h-3.5 w-3.5" /> {t('showStatus.refresh')}
            </Button>
          </div>
          <p className="text-sm">
            {t(`showStatus.banner.${r.recommendation}` as 'showStatus.banner.unknown')}
          </p>
          {(r.recommendation === 'not_recommended') && (
            <p className="text-xs text-muted-foreground">{t('showStatus.backfillSuggestion')}</p>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {nextDate && (
              <span className="inline-flex items-center gap-1">
                <CalendarClock className="h-3.5 w-3.5" /> {t('showStatus.nextEpisode', { date: nextDate })}
              </span>
            )}
            {!nextDate && lastDate && (
              <span>{t('showStatus.lastAired', { date: lastDate })}</span>
            )}
            {r.provider !== 'none' && (
              <span>
                {t('showStatus.providerConfidence', {
                  provider: r.provider,
                  pct: Math.round(r.confidence * 100),
                })}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export const showStatusIsInactive = (s: RssShowStatus | undefined): boolean =>
  s === 'ended' || s === 'canceled';
