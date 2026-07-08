import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronRight, Clapperboard, Layers, Tv } from 'lucide-react';
import { api, type MediaItem, type MediaSeasonGroup, type MediaSeriesGroup } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { Pagination } from '@/components/ui/pagination';
import { MediaPoster } from '@/components/media/MediaPoster';
import { cn } from '@/lib/utils';

const SERIES_PAGE_SIZE = 10;

interface SeriesFilters {
  mediaType?: string;
  matchStatus?: string;
  libraryId?: string;
  search?: string;
}

/**
 * TV browser: shows grouped into a collapsible Show → Season → Episode tree,
 * paginated by show. Grouping is done server-side by show folder (so a folder
 * of episode-titled files reads as one show, never a row per episode); a show's
 * seasons + episodes are fetched lazily on first expand.
 */
export function SeriesGroupedList({ mediaType, matchStatus, libraryId, search }: SeriesFilters) {
  const { t } = useTranslation('media');
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [mediaType, matchStatus, libraryId, search]);

  const q = useQuery({
    queryKey: ['media', 'series', { mediaType, matchStatus, libraryId, search, page }],
    queryFn: () => api.media.listSeries({ mediaType, matchStatus, libraryId, search, page, pageSize: SERIES_PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  if (q.isLoading) return <div className="p-6"><CenteredSpinner label={t('items.loading')} /></div>;
  if (q.isError) return <div className="p-6"><ErrorState message={t('items.error')} onRetry={() => q.refetch()} /></div>;

  const series = q.data?.items ?? [];
  if (series.length === 0) {
    return (
      <div className="p-6">
        <EmptyState icon={<Tv className="h-6 w-6" />} title={t('items.series.emptyTitle')} description={t('items.series.emptyBody')} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {series.map((s) => (
          <SeriesRow key={s.key} series={s} filters={{ matchStatus, libraryId }} />
        ))}
      </ul>
      <Pagination page={page} pageSize={SERIES_PAGE_SIZE} total={q.data?.total ?? 0} onPage={setPage} busy={q.isFetching} />
    </div>
  );
}

function SeriesRow({ series, filters }: { series: MediaSeriesGroup; filters: { matchStatus?: string; libraryId?: string } }) {
  const { t } = useTranslation('media');
  const [open, setOpen] = useState(false);

  const epQ = useQuery({
    queryKey: ['media', 'series', 'episodes', series.key, filters],
    queryFn: () => api.media.seriesEpisodes(series.key, filters),
    enabled: open,
  });
  const seasons = epQ.data?.seasons ?? [];

  return (
    <li>
      <Card className="overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-white/[0.02]"
        >
          <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <MediaPoster artwork={series.poster} alt={series.title} className="h-[7.5rem] w-20 shrink-0 rounded ring-1 ring-white/10" iconClassName="h-7 w-7" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{series.title}</span>
              {series.year != null && <span className="text-xs text-muted-foreground">({series.year})</span>}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><Layers className="h-3.5 w-3.5" />{t('items.series.seasons', { count: series.seasonCount })}</span>
              <span className="flex items-center gap-1"><Clapperboard className="h-3.5 w-3.5" />{t('items.series.episodes', { count: series.episodeCount })}</span>
            </div>
          </div>
        </button>

        {open && (
          <div className="border-t border-white/5 bg-black/10 p-2">
            {epQ.isLoading ? (
              <div className="py-4"><CenteredSpinner label={t('items.series.loadingEpisodes')} /></div>
            ) : epQ.isError ? (
              <ErrorState message={t('items.error')} onRetry={() => epQ.refetch()} />
            ) : (
              <div className="space-y-1">
                {seasons.map((s) => (
                  <SeasonRow key={s.seasonNumber} season={s} />
                ))}
              </div>
            )}
          </div>
        )}
      </Card>
    </li>
  );
}

function SeasonRow({ season }: { season: MediaSeasonGroup }) {
  const { t } = useTranslation('media');
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const label = season.seasonNumber === 0 ? t('items.series.specials') : t('items.series.season', { season: season.seasonNumber });

  return (
    <div className="rounded-md">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-white/[0.03]"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <MediaPoster artwork={season.poster} alt={label} className="h-9 w-6 shrink-0 rounded-sm ring-1 ring-white/10" iconClassName="h-3.5 w-3.5" />
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{t('items.series.episodes', { count: season.episodeCount })}</span>
      </button>
      {open && (
        <ul className="ml-6 border-l border-white/5 pl-2">
          {season.episodes.map((ep) => (
            <li key={ep.id}>
              <button
                type="button"
                onClick={() => navigate(`/media/items/${ep.id}`)}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-muted-foreground transition-colors hover:bg-white/[0.03] hover:text-foreground"
              >
                <span className="w-12 shrink-0 tabular-nums text-xs">
                  {ep.season != null && ep.episode != null ? `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}` : '—'}
                </span>
                <span className="min-w-0 flex-1 truncate">{episodeLabel(ep)}</span>
                {ep.matchStatus === 'unmatched' && <Badge variant="secondary">{t('items.series.unmatched')}</Badge>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Prefer the metadata episode title; fall back to the item title. */
function episodeLabel(ep: MediaItem): string {
  const epTitle = ep.metadata?.title;
  if (epTitle && epTitle !== ep.title) return epTitle;
  return ep.title;
}
