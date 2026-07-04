import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clapperboard, RotateCw, Sparkles, Undo2 } from 'lucide-react';
import { ApiError, api, type MediaItem } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import {
  matchStatusLabel,
  matchStatusOptions,
  matchStatusVariant,
  mediaTypeLabel,
  mediaTypeOptions,
} from './constants';

function seasonEpisode(item: MediaItem): string {
  if (item.season == null && item.episode == null) return '—';
  const s = item.season != null ? `S${String(item.season).padStart(2, '0')}` : '';
  const e = item.episode != null ? `E${String(item.episode).padStart(2, '0')}` : '';
  return `${s}${e}` || '—';
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

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['media', 'items', { mediaType, matchStatus, libraryId }],
    queryFn: () => api.media.listItems({ mediaType, matchStatus, libraryId }),
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

  const items = data ?? [];
  const hasFilters = Boolean(mediaType || matchStatus || libraryId);

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/media')} className="mb-2 -ml-2">
          {t('common.backToManager')}
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">{t('items.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('items.subtitle')}
        </p>
      </div>

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-3">
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
                description={
                  hasFilters ? t('items.emptyFilteredBody') : t('items.emptyBody')
                }
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
            <div className="overflow-x-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[280px] pl-4">{t('items.col.title')}</TableHead>
                    <TableHead className="w-[120px]">{t('items.col.type')}</TableHead>
                    <TableHead className="w-[80px]">{t('items.col.year')}</TableHead>
                    <TableHead className="w-[110px]">{t('items.col.seasonEp')}</TableHead>
                    <TableHead className="w-[130px]">{t('items.col.match')}</TableHead>
                    <TableHead className="w-[110px]">{t('items.col.confidence')}</TableHead>
                    {canMatch && <TableHead className="w-[230px] pr-4 text-right">{t('items.col.actions')}</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => {
                    const busy =
                      (reidentify.isPending && reidentify.variables === item.id) ||
                      (unmatch.isPending && unmatch.variables === item.id);
                    return (
                      <TableRow key={item.id}>
                        <TableCell className="pl-4">
                          <p className="font-medium">{item.title}</p>
                          <p className="truncate font-mono text-xs text-muted-foreground">{item.path}</p>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{mediaTypeLabel(t, item.mediaType)}</Badge>
                        </TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">{item.year ?? '—'}</TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">{seasonEpisode(item)}</TableCell>
                        <TableCell>
                          <Badge variant={matchStatusVariant(item.matchStatus)} dot>
                            {matchStatusLabel(t, item.matchStatus)}
                          </Badge>
                        </TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">
                          {Math.round((item.confidence ?? 0) * 100)}%
                        </TableCell>
                        {canMatch && (
                          <TableCell className="pr-4">
                            <div className="flex items-center justify-end gap-2">
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
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
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
