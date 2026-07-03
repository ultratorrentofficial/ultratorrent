import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
  MATCH_STATUS_OPTIONS,
  MEDIA_TYPE_OPTIONS,
  matchStatusLabel,
  matchStatusVariant,
  mediaTypeLabel,
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
      { value: '', label: 'All libraries' },
      ...(librariesQuery.data ?? []).map((l) => ({ value: l.id, label: l.name })),
    ],
    [librariesQuery.data],
  );

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['media'] });

  const reidentify = useMutation({
    mutationFn: (id: string) => api.media.matchItem(id),
    onSuccess: (item) => {
      toast.success('Re-identified', `${item.title} — ${matchStatusLabel(item.matchStatus)}.`);
      invalidate();
    },
    onError: (err) => toast.error('Could not re-identify', err instanceof ApiError ? err.message : undefined),
  });

  const unmatch = useMutation({
    mutationFn: (id: string) => api.media.unmatchItem(id),
    onSuccess: (item) => {
      toast.success('Unmatched', item.title);
      invalidate();
    },
    onError: (err) => toast.error('Could not unmatch', err instanceof ApiError ? err.message : undefined),
  });

  const items = data ?? [];
  const hasFilters = Boolean(mediaType || matchStatus || libraryId);

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/media')} className="mb-2 -ml-2">
          Media Manager
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">Media Items</h1>
        <p className="text-sm text-muted-foreground">
          Everything Media Manager has scanned. Re-identify to re-run automatic matching, or unmatch
          to clear a bad identity.
        </p>
      </div>

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-3">
          <div>
            <Label htmlFor="filter-type">Type</Label>
            <Select
              id="filter-type"
              value={mediaType}
              onChange={(e) => setFilter('mediaType', e.target.value)}
              options={[{ value: '', label: 'All types' }, ...MEDIA_TYPE_OPTIONS]}
            />
          </div>
          <div>
            <Label htmlFor="filter-status">Match status</Label>
            <Select
              id="filter-status"
              value={matchStatus}
              onChange={(e) => setFilter('matchStatus', e.target.value)}
              options={[{ value: '', label: 'All statuses' }, ...MATCH_STATUS_OPTIONS]}
            />
          </div>
          <div>
            <Label htmlFor="filter-library">Library</Label>
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
              <CenteredSpinner label="Loading items…" />
            </div>
          ) : isError ? (
            <div className="p-6">
              <ErrorState message="Could not load media items." onRetry={() => refetch()} />
            </div>
          ) : items.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={<Clapperboard className="h-6 w-6" />}
                title={hasFilters ? 'No items match these filters' : 'No items yet'}
                description={
                  hasFilters
                    ? 'Try clearing a filter, or scan a library to add items.'
                    : 'Scan a library to populate this list.'
                }
                action={
                  hasFilters ? (
                    <Button variant="outline" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                      Clear filters
                    </Button>
                  ) : (
                    <Button onClick={() => navigate('/media/libraries')}>Go to libraries</Button>
                  )
                }
              />
            </div>
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[280px] pl-4">Title</TableHead>
                    <TableHead className="w-[120px]">Type</TableHead>
                    <TableHead className="w-[80px]">Year</TableHead>
                    <TableHead className="w-[110px]">Season/Ep</TableHead>
                    <TableHead className="w-[130px]">Match</TableHead>
                    <TableHead className="w-[110px]">Confidence</TableHead>
                    {canMatch && <TableHead className="w-[230px] pr-4 text-right">Actions</TableHead>}
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
                          <Badge variant="secondary">{mediaTypeLabel(item.mediaType)}</Badge>
                        </TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">{item.year ?? '—'}</TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">{seasonEpisode(item)}</TableCell>
                        <TableCell>
                          <Badge variant={matchStatusVariant(item.matchStatus)} dot>
                            {matchStatusLabel(item.matchStatus)}
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
                                <RotateCw className="h-4 w-4" /> Re-identify
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
                                  <Undo2 className="h-4 w-4" /> Unmatch
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
        {items.length.toLocaleString()} item{items.length === 1 ? '' : 's'}
        {isFetching && <span className="opacity-70"> · updating…</span>}
      </p>
    </div>
  );
}
