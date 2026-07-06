import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clapperboard, Clock, ExternalLink, RotateCw, Sparkles, Star, Undo2 } from 'lucide-react';
import { ApiError, api, type MediaArtwork, type MediaFile, type MediaItem } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { MediaPoster } from '@/components/media/MediaPoster';
import { formatBytes } from '@/lib/format';
import {
  matchStatusLabel,
  matchStatusOptions,
  matchStatusVariant,
  mediaTypeLabel,
  mediaTypeOptions,
} from './constants';

function seasonEpisode(item: MediaItem): string | null {
  if (item.season == null && item.episode == null) return null;
  const s = item.season != null ? `S${String(item.season).padStart(2, '0')}` : '';
  const e = item.episode != null ? `E${String(item.episode).padStart(2, '0')}` : '';
  return `${s}${e}` || null;
}

/** The poster to show for a row (selected first, then any poster). */
function posterOf(item: MediaItem): MediaArtwork | null {
  const art = item.artwork ?? [];
  return art.find((a) => a.type === 'poster' && a.selected) ?? art.find((a) => a.type === 'poster') ?? art[0] ?? null;
}

/** The largest video file drives the technical badges. */
function primaryFile(item: MediaItem): MediaFile | null {
  const files = item.files ?? [];
  if (files.length === 0) return null;
  return [...files].sort((a, b) => Number(b.size ?? 0) - Number(a.size ?? 0))[0];
}

function formatRuntime(min: number | null | undefined): string | null {
  if (!min || min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Technical spec chips from the primary file (resolution, codec, HDR, size). */
function techBits(file: MediaFile | null): string[] {
  if (!file) return [];
  const bits: string[] = [];
  if (file.resolution) bits.push(file.resolution);
  if (file.videoCodec) bits.push(file.videoCodec);
  if (file.hdr) bits.push(file.hdr);
  if (file.audioCodec) bits.push(file.audioCodec);
  if (file.size && Number(file.size) > 0) bits.push(formatBytes(Number(file.size)));
  if (file.container) bits.push(file.container.toUpperCase());
  return bits;
}

export function MediaItemsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const { t } = useTranslation('media');
  const canMatch = hasPermission(PERMISSIONS.MEDIA_MANAGER_MATCH);

  const [params, setParams] = useSearchParams();
  const mediaType = params.get('mediaType') ?? '';
  const matchStatus = params.get('matchStatus') ?? '';
  const libraryId = params.get('libraryId') ?? '';

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const librariesQuery = useQuery({ queryKey: ['media', 'libraries'], queryFn: api.media.listLibraries });

  const PAGE_SIZE = 60;
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  // Debounce the search box so we don't refetch on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);
  // Any filter/search change resets to the first page.
  useEffect(() => setPage(1), [mediaType, matchStatus, libraryId, search]);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['media', 'items', { mediaType, matchStatus, libraryId, search, page }],
    queryFn: () => api.media.listItems({ mediaType, matchStatus, libraryId, search, page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const libraryOptions = useMemo(
    () => [
      { value: '', label: t('items.filter.allLibraries') },
      ...(librariesQuery.data ?? []).map((l) => ({ value: l.id, label: l.name })),
    ],
    [librariesQuery.data, t],
  );

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['media'] });

  const reidentify = useMutation({
    mutationFn: (id: string) => api.media.matchItem(id),
    onSuccess: (item) => {
      toast.success(
        t('items.reidentifiedTitle'),
        t('items.reidentifiedBody', { title: item.title, status: matchStatusLabel(t, item.matchStatus) }),
      );
      invalidate();
    },
    onError: (err) => toast.error(t('items.reidentifyError'), err instanceof ApiError ? err.message : undefined),
  });

  const unmatch = useMutation({
    mutationFn: (id: string) => api.media.unmatchItem(id),
    onSuccess: (item) => {
      toast.success(t('items.unmatchedTitle'), item.title);
      invalidate();
    },
    onError: (err) => toast.error(t('items.unmatchError'), err instanceof ApiError ? err.message : undefined),
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = Boolean(mediaType || matchStatus || libraryId || search);
  const open = (id: string) => navigate(`/media/items/${id}`);

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/media')} className="mb-2 -ml-2">
          {t('common.backToManager')}
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">{t('items.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('items.subtitle')}</p>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div>
            <Label htmlFor="filter-search">{t('items.filter.search')}</Label>
            <Input
              id="filter-search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t('items.filter.searchPlaceholder')}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="filter-type">{t('items.filter.type')}</Label>
            <Select
              id="filter-type"
              value={mediaType}
              onChange={(e) => setFilter('mediaType', e.target.value)}
              options={[{ value: '', label: t('items.filter.allTypes') }, ...mediaTypeOptions(t)]}
            />
          </div>
          <div>
            <Label htmlFor="filter-status">{t('items.filter.status')}</Label>
            <Select
              id="filter-status"
              value={matchStatus}
              onChange={(e) => setFilter('matchStatus', e.target.value)}
              options={[{ value: '', label: t('items.filter.allStatuses') }, ...matchStatusOptions(t)]}
            />
          </div>
          <div>
            <Label htmlFor="filter-library">{t('items.filter.library')}</Label>
            <Select
              id="filter-library"
              value={libraryId}
              onChange={(e) => setFilter('libraryId', e.target.value)}
              options={libraryOptions}
            />
          </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6">
              <CenteredSpinner label={t('items.loading')} />
            </div>
          ) : isError ? (
            <div className="p-6">
              <ErrorState message={t('items.error')} onRetry={() => refetch()} />
            </div>
          ) : items.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={<Clapperboard className="h-6 w-6" />}
                title={hasFilters ? t('items.emptyFilteredTitle') : t('items.emptyTitle')}
                description={hasFilters ? t('items.emptyFilteredBody') : t('items.emptyBody')}
                action={
                  hasFilters ? (
                    <Button variant="outline" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                      {t('items.clearFilters')}
                    </Button>
                  ) : (
                    <Button onClick={() => navigate('/media/libraries')}>{t('items.goToLibraries')}</Button>
                  )
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {items.map((item) => {
                const busy =
                  (reidentify.isPending && reidentify.variables === item.id) ||
                  (unmatch.isPending && unmatch.variables === item.id);
                const poster = posterOf(item);
                const file = primaryFile(item);
                const meta = item.metadata ?? null;
                const genres = meta?.genres?.slice(0, 4) ?? [];
                const runtime = formatRuntime(meta?.runtime);
                const rating = meta?.rating != null ? meta.rating.toFixed(1) : null;
                const se = seasonEpisode(item);
                const bits = techBits(file);
                const externalIds = item.externalIds ?? [];

                return (
                  <li key={item.id} className="flex gap-4 p-4 transition-colors hover:bg-white/[0.02]">
                    <button
                      type="button"
                      onClick={() => open(item.id)}
                      aria-label={t('items.viewDetails', { title: item.title })}
                      className="shrink-0 rounded-md ring-offset-background transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <MediaPoster
                        artwork={poster}
                        alt={item.title}
                        className="aspect-[2/3] w-16 rounded-md sm:w-20"
                      />
                    </button>

                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <button
                          type="button"
                          onClick={() => open(item.id)}
                          className="truncate text-left font-semibold hover:underline focus-visible:outline-none focus-visible:underline"
                          title={item.title}
                        >
                          {item.title}
                          {item.year != null && (
                            <span className="ml-1.5 font-normal text-muted-foreground">({item.year})</span>
                          )}
                        </button>
                        {rating && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums text-amber-400">
                            <Star className="h-3.5 w-3.5 fill-amber-400" />
                            {rating}
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary">{mediaTypeLabel(t, item.mediaType)}</Badge>
                        <Badge variant={matchStatusVariant(item.matchStatus)} dot>
                          {matchStatusLabel(t, item.matchStatus)}
                        </Badge>
                        {se && <Badge variant="outline" className="tabular-nums">{se}</Badge>}
                        {meta?.certification && <Badge variant="outline">{meta.certification}</Badge>}
                        {runtime && (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <Clock className="h-3 w-3" />
                            {runtime}
                          </span>
                        )}
                        {item.matchStatus !== 'unmatched' && (
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {t('items.confidenceShort', { value: Math.round((item.confidence ?? 0) * 100) })}
                          </span>
                        )}
                      </div>

                      {meta?.overview && (
                        <p className="line-clamp-2 text-sm text-muted-foreground">{meta.overview}</p>
                      )}

                      {genres.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {genres.map((g) => (
                            <span key={g} className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              {g}
                            </span>
                          ))}
                        </div>
                      )}

                      {bits.length > 0 && (
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                          {bits.map((b, i) => (
                            <span key={`${b}-${i}`} className="inline-flex items-center gap-2">
                              {i > 0 && <span className="text-muted-foreground/40">·</span>}
                              {b}
                            </span>
                          ))}
                        </div>
                      )}

                      {externalIds.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {externalIds.map((x) =>
                            x.url ? (
                              <a
                                key={x.id}
                                href={x.url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[11px] font-medium uppercase text-muted-foreground transition hover:border-primary/50 hover:text-foreground"
                              >
                                {x.provider}
                                <ExternalLink className="h-2.5 w-2.5" />
                              </a>
                            ) : (
                              <span
                                key={x.id}
                                className="rounded border border-border/60 px-1.5 py-0.5 text-[11px] font-medium uppercase text-muted-foreground"
                              >
                                {x.provider}
                              </span>
                            ),
                          )}
                        </div>
                      )}

                      <p className="truncate font-mono text-xs text-muted-foreground/70" title={item.path}>
                        {item.path}
                      </p>
                    </div>

                    {canMatch && (
                      <div className="flex shrink-0 flex-col items-end gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          className="whitespace-nowrap"
                          onClick={() => reidentify.mutate(item.id)}
                          loading={reidentify.isPending && reidentify.variables === item.id}
                          disabled={busy}
                        >
                          <RotateCw className="h-4 w-4" /> {t('items.reidentify')}
                        </Button>
                        {item.matchStatus !== 'unmatched' && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="whitespace-nowrap"
                            onClick={() => unmatch.mutate(item.id)}
                            loading={unmatch.isPending && unmatch.variables === item.id}
                            disabled={busy}
                          >
                            <Undo2 className="h-4 w-4" /> {t('items.unmatch')}
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {!isLoading && !isError && total > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 p-3">
              <span className="text-xs text-muted-foreground">
                {t('items.pagination.showing', {
                  from: (page - 1) * PAGE_SIZE + 1,
                  to: Math.min(page * PAGE_SIZE, total),
                  total,
                })}
              </span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1 || isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  {t('items.pagination.prev')}
                </Button>
                <span className="text-xs tabular-nums text-muted-foreground">{t('items.pagination.page', { page, totalPages })}</span>
                <Button variant="outline" size="sm" disabled={page >= totalPages || isFetching} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                  {t('items.pagination.next')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" />
        {t('common.items', { count: items.length })}
        {isFetching && <span className="opacity-70"> · {t('common.updating')}</span>}
      </p>
    </div>
  );
}
