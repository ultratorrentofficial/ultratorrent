import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Grid2x2, LayoutGrid, List, Rows3, Table2 } from 'lucide-react';
import { api, type MediaLibrary, type MediaSeriesGroup, type MediaItem } from '@/lib/api';
import { MediaPoster } from '@/components/media/MediaPoster';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';
import { VirtualPosterGrid } from './VirtualPosterGrid';
import { ShowDetailView } from './ShowDetailView';
import { VIEW_MODES, readViewMode, writeViewMode, type ViewMode } from './view-mode';

const MODE_ICON: Record<ViewMode, typeof LayoutGrid> = {
  poster: LayoutGrid,
  grid: Grid2x2,
  list: Rows3,
  compact: List,
  table: Table2,
};

/** One page of shows/items per request — the browser never fetches a whole library. */
const PAGE_SIZE = 60;

/**
 * The Library Browser.
 *
 * A poster-first way through a library, in place of the paginated single-column
 * list. It composes the endpoints the Media Manager already exposes rather than
 * adding any of its own: `GET /media/series` for a TV wall (which already
 * returns a poster and episode/season counts per show) and `GET /media/items`
 * for everything else. Nothing here changes the data model — a show is still a
 * projection over flat `MediaItem` rows.
 *
 * Paging is server-side and additive: rows are appended as the grid nears its
 * end, so scrolling a 500 000-item library costs one request per screenful
 * rather than one enormous response.
 */
export function LibraryBrowserPage() {
  const { t } = useTranslation('media');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const libraryId = params.get('library');
  // Drill-down state in the URL rather than component state: browser Back must
  // return to the wall, and a show view should survive a reload and be linkable.
  const showKey = params.get('show');
  const showTitle = params.get('showTitle') ?? '';
  const [mode, setMode] = useState<ViewMode>(() => readViewMode(libraryId));

  // Re-read on library change: the preference is per library, so switching
  // libraries should restore that library's own layout rather than carry one over.
  useEffect(() => setMode(readViewMode(libraryId)), [libraryId]);

  const chooseMode = useCallback((next: ViewMode) => {
    setMode(next);
    writeViewMode(libraryId, next);
  }, [libraryId]);

  const libraries = useQuery({ queryKey: ['media', 'libraries'], queryFn: api.media.listLibraries });

  const library = useMemo(
    () => libraries.data?.find((l) => l.id === libraryId) ?? null,
    [libraries.data, libraryId],
  );

  // A TV/anime library browses by show; everything else by item. The library's
  // declared kind is authoritative — the same rule identification already uses,
  // rather than inferring from what the rows happen to contain.
  const browsesByShow = library ? library.kind === 'tv' || library.kind === 'anime' : false;

  const shows = useInfiniteQuery({
    queryKey: ['library-browser', 'series', libraryId],
    enabled: !!libraryId && browsesByShow,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      api.media.listSeries({ libraryId: libraryId!, page: pageParam, pageSize: PAGE_SIZE }),
    getNextPageParam: (last, all) =>
      all.flatMap((p) => p.items).length < last.total ? all.length + 1 : undefined,
  });

  const items = useInfiniteQuery({
    queryKey: ['library-browser', 'items', libraryId],
    enabled: !!libraryId && !browsesByShow,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      api.media.listItems({ libraryId: libraryId!, page: pageParam, pageSize: PAGE_SIZE }),
    getNextPageParam: (last, all) =>
      all.flatMap((p) => p.items).length < last.total ? all.length + 1 : undefined,
  });

  const active = browsesByShow ? shows : items;
  const rows = useMemo(
    () => (active.data?.pages ?? []).flatMap((p: { items: unknown[] }) => p.items),
    [active.data],
  );
  const total = active.data?.pages?.[0]?.total ?? 0;

  const loadMore = useCallback(() => {
    if (active.hasNextPage && !active.isFetchingNextPage) active.fetchNextPage();
  }, [active]);

  /* ------------------------------------------------------------- library picker */

  if (libraries.isLoading) return <BrowserSkeleton />;
  if (libraries.isError) {
    return <ErrorState message={t('browser.loadFailed')} onRetry={() => libraries.refetch()} />;
  }

  const all = libraries.data ?? [];
  if (!all.length) return <EmptyState title={t('browser.noLibraries')} />;

  if (!library) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">{t('browser.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('browser.pickLibrary')}</p>
        </header>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {all.map((lib) => (
            <LibraryCard key={lib.id} library={lib} onOpen={() => setParams({ library: lib.id })} />
          ))}
        </div>
      </div>
    );
  }

  /* -------------------------------------------------------------- the browser */

  if (showKey) {
    return (
      <div className="flex h-[calc(100vh-8rem)] flex-col">
        <ShowDetailView
          showKey={showKey}
          libraryId={library.id}
          title={showTitle || library.name}
          onBack={() => setParams({ library: library.id })}
        />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => setParams({})}>
          {t('browser.allLibraries')}
        </Button>
        <div>
          <h1 className="text-xl font-semibold">{library.name}</h1>
          <p className="text-xs text-muted-foreground">
            {t(browsesByShow ? 'browser.showCount' : 'browser.itemCount', { count: total })}
          </p>
        </div>
        <span className="flex-1" />
        <div className="flex items-center gap-1 rounded-lg border border-white/10 p-1" role="group"
             aria-label={t('browser.viewMode')}>
          {VIEW_MODES.map((m) => {
            const Icon = MODE_ICON[m];
            return (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                aria-label={t(`browser.mode.${m}`)}
                title={t(`browser.mode.${m}`)}
                onClick={() => chooseMode(m)}
                className={cn(
                  'rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground',
                  mode === m && 'bg-white/10 text-foreground',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
              </button>
            );
          })}
        </div>
      </header>

      {active.isLoading ? (
        <BrowserSkeleton />
      ) : active.isError ? (
        <ErrorState message={t('browser.loadFailed')} onRetry={() => active.refetch()} />
      ) : (
        <div className="min-h-0 flex-1">
          <VirtualPosterGrid
            items={rows as Array<MediaSeriesGroup | MediaItem>}
            mode={mode}
            onEndReached={loadMore}
            emptyState={<EmptyState title={t('browser.empty')} />}
            itemKey={(row) => ('key' in row ? row.key : row.id)}
            renderItem={(row) =>
              'key' in row ? (
                <ShowCell
                  show={row}
                  mode={mode}
                  onOpen={() =>
                    setParams({ library: libraryId!, show: row.key, showTitle: row.title })
                  }
                />
              ) : (
                <ItemCell item={row} mode={mode} onOpen={() => navigate(`/media/items/${row.id}`)} />
              )
            }
          />
        </div>
      )}

      {active.isFetchingNextPage && (
        <p className="text-center text-xs text-muted-foreground">{t('browser.loadingMore')}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function LibraryCard({ library, onOpen }: { library: MediaLibrary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-left transition-colors hover:border-white/20 hover:bg-white/[0.06]"
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">{library.name}</span>
        <Badge variant="outline">{library.kind}</Badge>
      </div>
      {/* The path is shown because an operator picks a library by where it points,
          but it is never how anything is addressed — operations use ids. */}
      <p className="mt-1 truncate text-xs text-muted-foreground">{library.path}</p>
    </button>
  );
}

function ShowCell({ show, mode, onOpen }: {
  show: MediaSeriesGroup;
  mode: ViewMode;
  onOpen: () => void;
}) {
  // The hook rather than a passed-down `t`: the translation keys are literal
  // types, and threading the function through a prop erases them.
  const { t } = useTranslation('media');
  const listish = mode === 'list' || mode === 'table';
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group w-full overflow-hidden rounded-lg text-left transition-transform',
        listish ? 'flex items-center gap-3 px-2' : 'hover:-translate-y-0.5',
      )}
    >
      <MediaPoster
        artwork={show.poster}
        alt={show.title}
        size="thumb"
        className={cn('rounded-lg bg-white/5', listish ? 'h-12 w-8 shrink-0' : 'aspect-[2/3] w-full')}
      />
      <div className={cn('min-w-0', listish ? 'flex-1' : 'pt-1.5')}>
        <p className="truncate text-sm font-medium">{show.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {show.year ? `${show.year} · ` : ''}
          {t('browser.episodeCount', { count: show.episodeCount })}
        </p>
      </div>
    </button>
  );
}

function ItemCell({ item, mode, onOpen }: { item: MediaItem; mode: ViewMode; onOpen: () => void }) {
  const listish = mode === 'list' || mode === 'table';
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group w-full overflow-hidden rounded-lg text-left transition-transform',
        listish ? 'flex items-center gap-3 px-2' : 'hover:-translate-y-0.5',
      )}
    >
      <MediaPoster
        artwork={item.artwork?.[0] ?? null}
        alt={item.title}
        size="thumb"
        className={cn('rounded-lg bg-white/5', listish ? 'h-12 w-8 shrink-0' : 'aspect-[2/3] w-full')}
      />
      <div className={cn('min-w-0', listish ? 'flex-1' : 'pt-1.5')}>
        <p className="truncate text-sm font-medium">{item.title}</p>
        <p className="truncate text-xs text-muted-foreground">{item.year ?? ''}</p>
      </div>
    </button>
  );
}

/** Poster-shaped skeletons, so the first paint is the shape of the answer. */
function BrowserSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="aspect-[2/3] w-full rounded-lg" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ))}
    </div>
  );
}
