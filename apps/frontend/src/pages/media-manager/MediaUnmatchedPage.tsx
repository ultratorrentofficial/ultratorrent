import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Film, RotateCw, Search, Star } from 'lucide-react';
import {
  ApiError,
  api,
  type ImdbSearchResult,
  type MediaItem,
  type MediaItemType,
  type MediaManualMatchInput,
} from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { mediaTypeOptions, mediaTypeLabel } from './constants';

export function MediaUnmatchedPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { t } = useTranslation('media');
  const { hasPermission } = useAuth();
  const canMatch = hasPermission(PERMISSIONS.MEDIA_MANAGER_MATCH);
  const [matching, setMatching] = useState<MediaItem | null>(null);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['media', 'items', { matchStatus: 'unmatched' }],
    queryFn: () => api.media.listItems({ matchStatus: 'unmatched' }),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['media', 'items'] });

  const reidentify = useMutation({
    mutationFn: (id: string) => api.media.matchItem(id),
    onSuccess: (item) => {
      toast.success(t('unmatched.reidentifiedTitle'), item.title);
      invalidate();
    },
    onError: (err) => toast.error(t('unmatched.reidentifyError'), err instanceof ApiError ? err.message : undefined),
  });

  const items = data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/media')} className="mb-2 -ml-2">
          {t('common.backToManager')}
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">{t('unmatched.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('unmatched.subtitle')}
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6">
              <CenteredSpinner label={t('unmatched.loading')} />
            </div>
          ) : isError ? (
            <div className="p-6">
              <ErrorState message={t('unmatched.error')} onRetry={() => refetch()} />
            </div>
          ) : items.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={<CheckCircle2 className="h-6 w-6" />}
                title={t('unmatched.emptyTitle')}
                description={t('unmatched.emptyBody')}
              />
            </div>
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[280px] pl-4">{t('unmatched.col.title')}</TableHead>
                    <TableHead className="w-[120px]">{t('unmatched.col.type')}</TableHead>
                    <TableHead className="w-[80px]">{t('unmatched.col.year')}</TableHead>
                    <TableHead className="w-[110px]">{t('unmatched.col.confidence')}</TableHead>
                    {canMatch && <TableHead className="w-[260px] pr-4 text-right">{t('unmatched.col.actions')}</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="pl-4">
                        <button
                          className="text-left font-medium hover:underline"
                          onClick={() => navigate(`/media/items/${item.id}`)}
                        >
                          {item.title}
                        </button>
                        <p className="truncate font-mono text-xs text-muted-foreground">{item.path}</p>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{mediaTypeLabel(t, item.mediaType)}</Badge>
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{item.year ?? '—'}</TableCell>
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
                            >
                              <RotateCw className="h-4 w-4" /> {t('unmatched.reidentify')}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="whitespace-nowrap"
                              onClick={() => setMatching(item)}
                            >
                              <Search className="h-4 w-4" /> {t('unmatched.matchBtn')}
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        {t('unmatched.count', { count: items.length })}
        {isFetching && <span className="opacity-70"> · {t('common.updating')}</span>}
      </p>

      {matching && (
        <ManualMatchDialog
          item={matching}
          onClose={() => setMatching(null)}
          onMatched={() => {
            setMatching(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function ManualMatchDialog({
  item,
  onClose,
  onMatched,
}: {
  item: MediaItem;
  onClose: () => void;
  onMatched: () => void;
}) {
  const toast = useToast();
  const { t } = useTranslation('media');
  const { hasPermission } = useAuth();
  const canImdbSearch = hasPermission(PERMISSIONS.MEDIA_MANAGER_IMDB_SEARCH);
  const canImdbMatch = hasPermission(PERMISSIONS.MEDIA_MANAGER_IMDB_MATCH);
  const [title, setTitle] = useState(item.title);
  const [type, setType] = useState<MediaItemType>(item.mediaType);
  const [year, setYear] = useState(item.year != null ? String(item.year) : '');
  const [season, setSeason] = useState(item.season != null ? String(item.season) : '');
  const [episode, setEpisode] = useState(item.episode != null ? String(item.episode) : '');

  const match = useMutation({
    mutationFn: () => {
      const body: MediaManualMatchInput = {
        title: title.trim() || undefined,
        mediaType: type,
        year: year.trim() ? Number(year) : null,
        season: season.trim() ? Number(season) : null,
        episode: episode.trim() ? Number(episode) : null,
      };
      return api.media.matchItem(item.id, body);
    },
    onSuccess: (updated) => {
      toast.success(t('unmatched.matchedTitle'), updated.title);
      onMatched();
    },
    onError: (err) => toast.error(t('unmatched.matchError'), err instanceof ApiError ? err.message : undefined),
  });

  const imdbMatch = useMutation({
    mutationFn: (result: ImdbSearchResult) =>
      api.media.matchItemImdb(item.id, { imdbId: result.tconst, confidence: result.confidence }),
    onSuccess: (res) => {
      toast.success(t('unmatched.matchedImdbTitle'), res.item.title);
      onMatched();
    },
    onError: (err) => toast.error(t('unmatched.matchError'), err instanceof ApiError ? err.message : undefined),
  });

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{t('unmatched.dialog.title')}</DialogTitle>
        <DialogDescription>
          {t('unmatched.dialog.description')}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div>
          <Label htmlFor="mm-title">{t('unmatched.field.title')}</Label>
          <Input id="mm-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="mm-type">{t('unmatched.field.type')}</Label>
            <Select
              id="mm-type"
              value={type}
              onChange={(e) => setType(e.target.value as MediaItemType)}
              options={mediaTypeOptions(t)}
            />
          </div>
          <div>
            <Label htmlFor="mm-year">{t('unmatched.field.year')}</Label>
            <Input id="mm-year" type="number" value={year} onChange={(e) => setYear(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="mm-season">{t('unmatched.field.season')}</Label>
            <Input id="mm-season" type="number" value={season} onChange={(e) => setSeason(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="mm-episode">{t('unmatched.field.episode')}</Label>
            <Input id="mm-episode" type="number" value={episode} onChange={(e) => setEpisode(e.target.value)} />
          </div>
        </div>

        {canImdbSearch && (
          <ImdbSuggestions
            title={title}
            year={year}
            type={type}
            canMatch={canImdbMatch}
            onSelect={(r) => imdbMatch.mutate(r)}
            selectingId={imdbMatch.isPending ? imdbMatch.variables?.tconst : undefined}
            disabled={imdbMatch.isPending}
          />
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button onClick={() => match.mutate()} loading={match.isPending} disabled={!title.trim()}>
          {t('unmatched.matchItemBtn')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** IMDb match suggestions for the manual-match flow. */
function ImdbSuggestions({
  title,
  year,
  type,
  canMatch,
  onSelect,
  selectingId,
  disabled,
}: {
  title: string;
  year: string;
  type: MediaItemType;
  canMatch: boolean;
  onSelect: (result: ImdbSearchResult) => void;
  selectingId: string | undefined;
  disabled: boolean;
}) {
  const { t } = useTranslation('media');
  const imdbType = type === 'tv' || type === 'anime' ? 'tv' : type === 'movie' ? 'movie' : 'any';
  const search = useQuery({
    queryKey: ['media', 'imdb', 'search', { title: title.trim(), year, imdbType }],
    queryFn: () =>
      api.media.imdbSearch({
        title: title.trim(),
        year: year.trim() ? Number(year) : undefined,
        type: imdbType,
      }),
    enabled: title.trim().length > 1,
  });

  const results = search.data ?? [];

  return (
    <div className="space-y-2 border-t border-border/60 pt-4">
      <div className="flex items-center gap-2">
        <Film className="h-4 w-4 text-muted-foreground" />
        <p className="text-sm font-semibold">{t('unmatched.imdb.heading')}</p>
      </div>
      <div className="max-h-[32vh] overflow-y-auto scrollbar-thin">
        {title.trim().length <= 1 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {t('unmatched.imdb.enterTitle')}
          </p>
        ) : search.isLoading || search.isFetching ? (
          <CenteredSpinner label={t('unmatched.imdb.searching')} />
        ) : search.isError ? (
          <ErrorState message={t('unmatched.imdb.searchFailed')} onRetry={() => search.refetch()} />
        ) : results.length === 0 ? (
          <EmptyState
            icon={<Film className="h-6 w-6" />}
            title={t('unmatched.imdb.noMatchesTitle')}
            description={t('unmatched.imdb.noMatchesBody')}
          />
        ) : (
          <ul className="divide-y divide-border/40">
            {results.map((r) => (
              <li key={r.tconst} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium">{r.primaryTitle}</span>
                    {r.year != null && (
                      <span className="text-xs text-muted-foreground">({r.year})</span>
                    )}
                    <Badge variant="warning">{t('imdbSuggest.badge')}</Badge>
                    <Badge variant="secondary">{r.titleType}</Badge>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{r.tconst}</span>
                    {r.rating != null && (
                      <span className="flex items-center gap-0.5">
                        <Star className="h-3 w-3 text-warning" /> {r.rating.toFixed(1)}
                      </span>
                    )}
                    {r.numVotes != null && <span>{t('imdbSuggest.votes', { formatted: formatNumber(r.numVotes) })}</span>}
                    <Badge
                      variant={r.confidence >= 0.75 ? 'success' : r.confidence >= 0.5 ? 'info' : 'secondary'}
                    >
                      {t('imdbSuggest.matchPct', { pct: Math.round(r.confidence * 100) })}
                    </Badge>
                  </div>
                </div>
                {canMatch && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onSelect(r)}
                    loading={selectingId === r.tconst}
                    disabled={disabled}
                  >
                    {t('common.select')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
