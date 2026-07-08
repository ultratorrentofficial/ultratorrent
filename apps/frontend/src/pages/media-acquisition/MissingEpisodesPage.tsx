import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { PERMISSIONS } from '@ultratorrent/shared';
import {
  api,
  ApiError,
  type SeriesGapSummary,
  type WantedEpisode,
  type WantedEpisodeStatus,
  type WantedSearchStatus,
} from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { AddSeriesFromLibraryDialog } from './AddSeriesFromLibraryDialog';

const STATUS_VARIANT: Record<WantedEpisodeStatus, BadgeProps['variant']> = {
  owned: 'success',
  missing: 'destructive',
  unaired: 'info',
  ignored: 'secondary',
};

// Auto-acquire search state → badge variant (idle renders no badge).
const SEARCH_STATUS_VARIANT: Record<WantedSearchStatus, BadgeProps['variant']> = {
  idle: 'secondary',
  searching: 'info',
  grabbed: 'success',
  pending_approval: 'outline',
  no_results: 'secondary',
  failed: 'destructive',
};

const QK = ['mediaAcquisition', 'missingEpisodes'] as const;

export function MissingEpisodesPage() {
  const { t } = useTranslation('media');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);

  const gaps = useQuery({ queryKey: QK, queryFn: () => api.mediaAcquisition.missingEpisodes() });
  const imdb = useQuery({ queryKey: ['media', 'imdbStatus'], queryFn: () => api.media.imdbStatus() });

  const scanAll = useMutation({
    mutationFn: () => api.mediaAcquisition.scanMissingEpisodes(),
    onSuccess: (r) => {
      toast.success(
        t('acquisition.missingEpisodes.scannedAll', {
          series: r.series ?? 0,
          missing: r.missing ?? 0,
        }),
      );
      void queryClient.invalidateQueries({ queryKey: QK });
    },
    onError: (err) =>
      toast.error(
        t('acquisition.missingEpisodes.scanFailed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });

  const mirrorDate = imdb.data?.lastImport?.completedAt ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('acquisition.missingEpisodes.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('acquisition.missingEpisodes.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setPickerOpen(true)}>
            <Plus className="h-4 w-4" />
            {t('acquisition.missingEpisodes.addFromLibrary')}
          </Button>
          <Button onClick={() => scanAll.mutate()} disabled={scanAll.isPending}>
            <RefreshCw className={scanAll.isPending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            {scanAll.isPending
              ? t('acquisition.missingEpisodes.scanning')
              : t('acquisition.missingEpisodes.scanAll')}
          </Button>
        </div>
      </div>

      <AddSeriesFromLibraryDialog open={pickerOpen} onClose={() => setPickerOpen(false)} />
      {/* end header */}

      <p className="text-xs text-muted-foreground">
        {t('acquisition.missingEpisodes.staleNote', {
          date: mirrorDate ? formatDateTime(mirrorDate) : t('acquisition.missingEpisodes.unknownDate'),
        })}
      </p>

      {gaps.isLoading ? (
        <CenteredSpinner />
      ) : gaps.isError ? (
        <ErrorState
          title={t('acquisition.missingEpisodes.loadError')}
          onRetry={() => void gaps.refetch()}
        />
      ) : !gaps.data || gaps.data.length === 0 ? (
        <EmptyState
          title={t('acquisition.missingEpisodes.empty.title')}
          description={t('acquisition.missingEpisodes.empty.body')}
        />
      ) : (
        <div className="space-y-3">
          {gaps.data.map((series) => (
            <SeriesRow key={series.watchlistItemId} series={series} />
          ))}
        </div>
      )}
    </div>
  );
}

function SeriesRow({ series }: { series: SeriesGapSummary }) {
  const { t } = useTranslation('media');
  const toast = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canEvaluate = hasPermission(PERMISSIONS.MEDIA_ACQUISITION_EVALUATE);
  const canManage = hasPermission(PERMISSIONS.MEDIA_ACQUISITION_MANAGE_WATCHLIST);
  const [open, setOpen] = useState(false);

  const episodes = useQuery({
    queryKey: ['mediaAcquisition', 'missingEpisodes', series.watchlistItemId],
    queryFn: () => api.mediaAcquisition.missingEpisodesForSeries(series.watchlistItemId),
    enabled: open,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: QK });
    void queryClient.invalidateQueries({
      queryKey: ['mediaAcquisition', 'missingEpisodes', series.watchlistItemId],
    });
  };

  const scan = useMutation({
    mutationFn: () => api.mediaAcquisition.scanMissingEpisodes(series.watchlistItemId),
    onSuccess: (r) => {
      toast.success(t('acquisition.missingEpisodes.scannedSeries', { missing: r.missing ?? 0 }));
      invalidate();
    },
    onError: (err) =>
      toast.error(
        t('acquisition.missingEpisodes.scanFailed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });

  const searchAll = useMutation({
    mutationFn: () => api.mediaAcquisition.searchMissingEpisodesForSeries(series.watchlistItemId),
    onSuccess: ({ results }) => {
      const grabbed = results.filter((r) => r.searchStatus === 'grabbed').length;
      toast.success(
        t('acquisition.missingEpisodes.searchSeriesDone', { count: results.length, grabbed }),
      );
      invalidate();
    },
    onError: (err) =>
      toast.error(
        t('acquisition.missingEpisodes.searchFailed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });

  const remove = useMutation({
    mutationFn: () => api.mediaAcquisition.deleteWatchlist(series.watchlistItemId),
    onSuccess: () => {
      toast.success(t('acquisition.missingEpisodes.removed', { title: series.title }));
      void queryClient.invalidateQueries({ queryKey: QK });
    },
    onError: (err) =>
      toast.error(
        t('acquisition.missingEpisodes.removeFailed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });

  const known = series.total - series.unaired; // episodes that could be owned
  const ownedFraction = known > 0 ? series.owned / known : 0;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 text-left"
            onClick={() => series.monitorable && setOpen((v) => !v)}
            disabled={!series.monitorable}
          >
            {series.monitorable &&
              (open ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              ))}
            <span className="truncate font-medium">{series.title}</span>
          </button>
          <div className="flex items-center gap-2">
            {series.monitorable && series.missing > 0 && (
              <Badge variant="destructive">
                {t('acquisition.missingEpisodes.counts.missing', { count: series.missing })}
              </Badge>
            )}
            {canEvaluate && series.monitorable && series.missing > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => searchAll.mutate()}
                disabled={searchAll.isPending}
              >
                <Search className={searchAll.isPending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                {t('acquisition.missingEpisodes.searchAll')}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => scan.mutate()}
              disabled={!series.monitorable || scan.isPending}
            >
              <RefreshCw className={scan.isPending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
              {t('acquisition.missingEpisodes.scanSeries')}
            </Button>
            {canManage && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (window.confirm(t('acquisition.missingEpisodes.confirmRemove', { title: series.title })))
                    remove.mutate();
                }}
                disabled={remove.isPending}
                aria-label={t('acquisition.missingEpisodes.remove', { title: series.title })}
                title={t('acquisition.missingEpisodes.remove', { title: series.title })}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className={remove.isPending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
              </Button>
            )}
          </div>
        </div>

        {!series.monitorable ? (
          <p className="text-xs text-warning">{t('acquisition.missingEpisodes.notMonitorable')}</p>
        ) : series.lastCheckedAt == null ? (
          <p className="text-xs text-muted-foreground">
            {t('acquisition.missingEpisodes.neverScanned')}
          </p>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Progress value={ownedFraction} className="flex-1" />
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatNumber(series.owned)} / {formatNumber(known)}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{t('acquisition.missingEpisodes.counts.owned', { count: series.owned })}</span>
              <span>{t('acquisition.missingEpisodes.counts.missingLabel', { count: series.missing })}</span>
              <span>{t('acquisition.missingEpisodes.counts.unaired', { count: series.unaired })}</span>
              {series.ignored > 0 && (
                <span>{t('acquisition.missingEpisodes.counts.ignored', { count: series.ignored })}</span>
              )}
              <span>{t('acquisition.missingEpisodes.lastChecked', { date: formatDateTime(series.lastCheckedAt) })}</span>
            </div>
          </>
        )}

        {open && (
          <div className="pt-1">
            {episodes.isLoading ? (
              <CenteredSpinner />
            ) : episodes.data && episodes.data.length > 0 ? (
              <EpisodeGrid rows={episodes.data} onChanged={invalidate} />
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('acquisition.missingEpisodes.noEpisodes')}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EpisodeGrid({ rows, onChanged }: { rows: WantedEpisode[]; onChanged: () => void }) {
  const { t } = useTranslation('media');
  const toast = useToast();
  const { hasPermission } = useAuth();
  const canEvaluate = hasPermission(PERMISSIONS.MEDIA_ACQUISITION_EVALUATE);

  const bySeason = new Map<number, WantedEpisode[]>();
  for (const r of rows) {
    if (!bySeason.has(r.seasonNumber)) bySeason.set(r.seasonNumber, []);
    bySeason.get(r.seasonNumber)!.push(r);
  }
  const seasons = [...bySeason.keys()].sort((a, b) => a - b);

  const toggle = useMutation({
    mutationFn: (row: WantedEpisode) =>
      row.status === 'ignored'
        ? api.mediaAcquisition.unignoreMissingEpisode(row.id)
        : api.mediaAcquisition.ignoreMissingEpisode(row.id),
    onSuccess: () => onChanged(),
    onError: (err) =>
      toast.error(
        t('acquisition.missingEpisodes.actionFailed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });

  const searchNow = useMutation({
    mutationFn: (row: WantedEpisode) => api.mediaAcquisition.searchMissingEpisode(row.id),
    onSuccess: (outcome) => {
      if (outcome.searchStatus === 'grabbed') {
        toast.success(t('acquisition.missingEpisodes.searchGrabbed', { title: outcome.releaseTitle ?? '' }));
      } else if (outcome.searchStatus === 'pending_approval') {
        toast.success(t('acquisition.missingEpisodes.searchQueued'));
      } else {
        toast.success(t('acquisition.missingEpisodes.searchNoResults'));
      }
      onChanged();
    },
    onError: (err) =>
      toast.error(
        t('acquisition.missingEpisodes.searchFailed'),
        err instanceof ApiError ? err.message : undefined,
      ),
  });

  return (
    <div className="space-y-3">
      {seasons.map((season) => (
        <div key={season}>
          <p className="mb-1 text-xs font-semibold text-muted-foreground">
            {t('acquisition.missingEpisodes.season', { n: season })}
          </p>
          <ul className="divide-y divide-white/5 rounded-md border border-white/5">
            {bySeason.get(season)!.map((row) => (
              <li key={row.id} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                <span className="w-14 shrink-0 tabular-nums text-muted-foreground">
                  S{String(row.seasonNumber).padStart(2, '0')}E{String(row.episodeNumber).padStart(2, '0')}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {row.episodeTitle ?? '—'}
                  {row.airYear != null && (
                    <span className="ml-2 text-xs text-muted-foreground">{row.airYear}</span>
                  )}
                </span>
                <Badge variant={STATUS_VARIANT[row.status]}>
                  {t(`acquisition.missingEpisodes.status.${row.status}`)}
                </Badge>
                {row.searchStatus && row.searchStatus !== 'idle' && (
                  <Badge variant={SEARCH_STATUS_VARIANT[row.searchStatus]}>
                    {t(`acquisition.missingEpisodes.searchStatus.${row.searchStatus}`)}
                  </Badge>
                )}
                {canEvaluate && row.status === 'missing' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('acquisition.missingEpisodes.searchNow')}
                    title={t('acquisition.missingEpisodes.searchNow')}
                    onClick={() => searchNow.mutate(row)}
                    disabled={searchNow.isPending && searchNow.variables?.id === row.id}
                  >
                    <Search className="h-3.5 w-3.5" />
                  </Button>
                )}
                {row.status !== 'owned' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toggle.mutate(row)}
                    disabled={toggle.isPending}
                  >
                    {row.status === 'ignored'
                      ? t('acquisition.missingEpisodes.unignore')
                      : t('acquisition.missingEpisodes.ignore')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
