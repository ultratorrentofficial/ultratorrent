import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Captions, ChevronLeft, Lock } from 'lucide-react';
import { api, type MediaItem, type MediaSeasonGroup } from '@/lib/api';
import { MediaPoster } from '@/components/media/MediaPoster';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { VirtualPosterGrid } from './VirtualPosterGrid';
import { episodeTitleOf } from './episode-title';

/**
 * One show, drilled into its seasons and episodes.
 *
 * The Library → Show → Season → Episode path, served entirely by the existing
 * `GET /media/series/episodes`, which returns a show's episodes already grouped
 * into ordered seasons with a season poster (falling back to the show's).
 *
 * Seasons are rendered plainly — a show has tens at most. Episodes are
 * virtualized, because a long-running series genuinely reaches several hundred
 * in one season list, and the point of this browser is that library size never
 * becomes the user's problem.
 */
export function ShowDetailView({
  showKey, libraryId, title, onBack,
}: {
  showKey: string;
  libraryId: string;
  title: string;
  onBack: () => void;
}) {
  const { t } = useTranslation('media');
  const [openSeason, setOpenSeason] = useState<number | null>(null);

  const query = useQuery({
    queryKey: ['library-browser', 'episodes', showKey, libraryId],
    queryFn: () => api.media.seriesEpisodes(showKey, { libraryId }),
  });

  const seasons = query.data?.seasons ?? [];

  // Default to the first season once loaded, so the drill-down lands on
  // something rather than an accordion the user must open to see anything.
  const activeSeason = useMemo(() => {
    if (openSeason != null) return seasons.find((s) => s.seasonNumber === openSeason) ?? null;
    return seasons[0] ?? null;
  }, [openSeason, seasons]);

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft className="mr-1 h-4 w-4" aria-hidden />
          {t('browser.backToLibrary')}
        </Button>
        <h2 className="truncate text-lg font-semibold">{title}</h2>
        {!!seasons.length && (
          <Badge variant="outline">{t('browser.seasonCount', { count: seasons.length })}</Badge>
        )}
      </header>

      {query.isLoading ? (
        <SeasonSkeleton />
      ) : query.isError ? (
        <ErrorState message={t('browser.loadFailed')} onRetry={() => query.refetch()} />
      ) : !seasons.length ? (
        <EmptyState title={t('browser.noEpisodes')} />
      ) : (
        <>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {seasons.map((season) => (
              <SeasonCard
                key={season.seasonNumber}
                season={season}
                active={activeSeason?.seasonNumber === season.seasonNumber}
                onOpen={() => setOpenSeason(season.seasonNumber)}
              />
            ))}
          </div>

          <div className="min-h-0 flex-1">
            {activeSeason && (
              <VirtualPosterGrid
                items={activeSeason.episodes}
                mode="list"
                itemKey={(ep) => ep.id}
                renderItem={(ep) => <EpisodeRow episode={ep} />}
                emptyState={<EmptyState title={t('browser.noEpisodes')} />}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SeasonCard({
  season, active, onOpen,
}: {
  season: MediaSeasonGroup;
  active: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation('media');
  const label = season.seasonNumber === 0
    ? t('browser.specials')
    : t('browser.seasonNumber', { number: season.seasonNumber });

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={active}
      className={cn(
        'w-28 shrink-0 rounded-lg border p-2 text-left transition-colors',
        active ? 'border-white/30 bg-white/[0.08]' : 'border-white/10 hover:border-white/20',
      )}
    >
      <MediaPoster
        artwork={season.poster}
        alt={label}
        size="thumb"
        className="aspect-[2/3] w-full rounded-md bg-white/5"
      />
      <p className="mt-1.5 truncate text-xs font-medium">{label}</p>
      <p className="truncate text-[11px] text-muted-foreground">
        {t('browser.episodeCount', { count: season.episodeCount })}
      </p>
    </button>
  );
}

function EpisodeRow({ episode }: { episode: MediaItem }) {
  const { t } = useTranslation('media');
  const file = episode.files?.[0];
  const meta = episode.metadata;

  /*
   * The episode's OWN still, never the show poster — a poster repeated down a
   * list says nothing about any episode.
   */
  const still = episode.artwork?.find(
    (a) => a.type === 'episode_thumbnail' || a.type === 'thumbnail',
  ) ?? null;

  /*
   * Both `MediaItem.title` and `metadata.title` hold the SHOW's name on a real
   * library, so the episode name comes from the filename the renamer wrote.
   * See `episode-title.ts` — this was measured, not assumed.
   */
  const episodeTitle = episodeTitleOf({
    path: episode.path,
    metadataTitle: meta?.title ?? null,
    showTitle: episode.title,
  });
  const subtitles = episode._count?.subtitles ?? 0;

  /*
   * Technical detail is shown only where it exists. The renamer strips exactly
   * these tokens from filenames, so on a renamed library most are null until
   * `MediaProbeService` has measured the file — a placeholder per field would
   * fill the row with dashes and imply the data is missing rather than
   * unmeasured.
   */
  const facts = [
    file?.resolution,
    file?.hdr,
    file?.videoCodec,
    meta?.runtime ? t('browser.minutes', { count: meta.runtime }) : null,
  ].filter(Boolean) as string[];

  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-white/[0.04]">
      <span className="w-9 shrink-0 text-right font-mono text-xs text-muted-foreground">
        {episode.episode != null ? `E${String(episode.episode).padStart(2, '0')}` : '—'}
      </span>

      {/* 16:9 — an episode still is a frame, not a poster. */}
      <MediaPoster
        artwork={still}
        alt={episodeTitle ?? `E${episode.episode ?? ''}`}
        size="thumb"
        className="h-9 w-16 shrink-0 rounded bg-white/5"
      />

      <div className="min-w-0 flex-1">
        {/* No episode name known — the number already identifies the row, and
            repeating the series title would be noise. */}
        <p className={cn('truncate text-sm', !episodeTitle && 'text-muted-foreground')}>
          {episodeTitle ?? t('browser.untitledEpisode', { number: episode.episode ?? 0 })}
        </p>
        {facts.length > 0 && (
          <p className="truncate text-xs text-muted-foreground">{facts.join(' · ')}</p>
        )}
      </div>

      {subtitles > 0 && (
        <span
          className="shrink-0 text-xs text-muted-foreground"
          title={t('browser.subtitleCount', { count: subtitles })}
        >
          <Captions className="inline h-3.5 w-3.5" aria-hidden /> {subtitles}
        </span>
      )}
      {episode.locked && (
        <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t('browser.locked')} />
      )}
      {episode.matchStatus === 'unmatched' && (
        <Badge variant="outline" className="shrink-0">{t('browser.unmatched')}</Badge>
      )}
    </div>
  );
}

function SeasonSkeleton() {
  return (
    <div className="flex gap-3">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="w-28 space-y-2">
          <Skeleton className="aspect-[2/3] w-full rounded-md" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}
