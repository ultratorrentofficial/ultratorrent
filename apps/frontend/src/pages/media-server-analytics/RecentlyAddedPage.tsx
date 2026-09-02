import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Clapperboard, Library, Tv } from 'lucide-react';
import { api, type MediaServerRecentlyAddedItem } from '@/lib/api';
import { formatDateTime, formatRelativeTimeShort } from '@/lib/format';
import { MediaPoster } from '@/components/media/MediaPoster';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { mediaTypeColor } from './analytics-colors';

/**
 * Media Server Analytics → Recently Added.
 *
 * This was a text list that threw away the two things it already had: the poster
 * on every row, and — once the query asked for it — the library each item landed
 * in. A title alone does not answer "did that film go to Movies or Animated
 * Movies", which is the mistake this page is scanned for.
 *
 * The media type is carried by a COLOURED ICON rather than a grey pill: a film
 * and an episode are different kinds of thing, and shape plus colour says so
 * without the reader parsing a word. The colour is the same `mediaTypeColor`
 * the dashboard strip and the charts use, so one hue means one thing everywhere.
 */

const TYPE_ICON = { movie: Clapperboard, tv: Tv } as const;

function isEpisode(item: MediaServerRecentlyAddedItem): boolean {
  return item.season != null || (item.mediaType ?? '').toLowerCase() === 'tv';
}

/** "S02E05", or null for anything without an episode number. */
function seasonEpisode(season: number | null, episode: number | null): string | null {
  if (season == null) return null;
  return `S${String(season).padStart(2, '0')}${episode != null ? `E${String(episode).padStart(2, '0')}` : ''}`;
}

function TypeMark({ item }: { item: MediaServerRecentlyAddedItem }) {
  const kind = isEpisode(item) ? 'tv' : 'movie';
  const Icon = TYPE_ICON[kind];
  const color = mediaTypeColor(item.mediaType);
  return (
    <span
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
      style={{ background: `${color}1F`, color }}
      title={item.mediaType}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </span>
  );
}

export function RecentlyAddedPage() {
  const { t } = useTranslation('mediaServerAnalytics');
  const q = useQuery({
    queryKey: ['mediaServerAnalytics', 'recently-added'],
    queryFn: () => api.mediaServerAnalytics.recentlyAdded(),
  });

  const [library, setLibrary] = useState<string>('');

  const libraries = useMemo(() => {
    const names = new Set<string>();
    for (const i of q.data ?? []) if (i.libraryName) names.add(i.libraryName);
    return [...names].sort();
  }, [q.data]);

  const rows = useMemo(
    () => (q.data ?? []).filter((i) => !library || i.libraryName === library),
    [q.data, library],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('recentlyAdded.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('recentlyAdded.subtitle')}</p>
        </div>
        {/* Only worth offering once there is more than one library to choose between. */}
        {libraries.length > 1 && (
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={library}
            onChange={(e) => setLibrary(e.target.value)}
            aria-label={t('recentlyAdded.col.library')}
          >
            <option value="">{t('recentlyAdded.allLibraries')}</option>
            {libraries.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        )}
      </div>

      {q.isLoading ? (
        <CenteredSpinner />
      ) : q.isError ? (
        <ErrorState title={t('recentlyAdded.loadError')} onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('recentlyAdded.empty')} />
      ) : (
        <ul className="divide-y divide-white/5 overflow-hidden rounded-lg border border-white/5">
          {rows.map((i) => {
            const se = seasonEpisode(i.season, i.episode);
            const color = mediaTypeColor(i.mediaType);
            return (
              <li key={i.id} className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-white/[0.03]">
                {/* A left rule in the type's colour: the row reads as a film or an
                    episode before any of its text is parsed. */}
                <span className="h-10 w-1 shrink-0 rounded-full" style={{ background: color }} aria-hidden />

                <MediaPoster
                  artwork={i.poster}
                  alt={i.title}
                  className="h-[54px] w-[36px] shrink-0 rounded ring-1 ring-white/10"
                  iconClassName="h-4 w-4"
                />

                <TypeMark item={i} />

                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium leading-tight">
                    {i.title}
                    {i.year != null && <span className="ml-1.5 font-normal text-muted-foreground">({i.year})</span>}
                  </span>
                  {se && <span className="text-xs tabular-nums text-muted-foreground">{se}</span>}
                </span>

                <span className="hidden min-w-0 shrink-0 items-center gap-1.5 sm:flex">
                  {i.libraryName ? (
                    <>
                      <Library className="h-3.5 w-3.5 text-muted-foreground/70" aria-hidden />
                      <span className="max-w-[12rem] truncate text-xs text-muted-foreground">{i.libraryName}</span>
                    </>
                  ) : (
                    <span className="text-xs italic text-muted-foreground/50">{t('recentlyAdded.noLibrary')}</span>
                  )}
                </span>

                <span
                  className="shrink-0 text-xs tabular-nums text-muted-foreground"
                  title={formatDateTime(i.addedAt)}
                >
                  {formatRelativeTimeShort(i.addedAt)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
