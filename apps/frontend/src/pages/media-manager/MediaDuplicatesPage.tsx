import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pagination } from '@/components/ui/pagination';

const DUPES_PAGE_SIZE = 25;
import { Copy, ScanSearch, Star } from 'lucide-react';
import { ApiError, api, type MediaDuplicateGroup } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { duplicateReasonLabel, seasonEpisodeLabel } from './constants';
import { DuplicateShowsPanel } from './DuplicateShowsPanel';

export function MediaDuplicatesPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { t } = useTranslation('media');

  const [page, setPage] = useState(1);
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['media', 'duplicates', page],
    queryFn: () => api.media.listDuplicates({ page, pageSize: DUPES_PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const detect = useMutation({
    mutationFn: api.media.detectDuplicates,
    onSuccess: (result) => {
      toast.success(
        t('duplicates.detectionCompleteTitle'),
        t('duplicates.detectionCompleteBody', { count: result.total }),
      );
      setPage(1);
      void queryClient.invalidateQueries({ queryKey: ['media', 'duplicates'] });
    },
    onError: (err) =>
      toast.error(t('duplicates.detectionFailed'), err instanceof ApiError ? err.message : undefined),
  });

  const groups = data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" onClick={() => navigate('/media')} className="mb-2 -ml-2">
            {t('common.backToManager')}
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">{t('duplicates.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('duplicates.subtitle')}
          </p>
        </div>
        <Button variant="secondary" onClick={() => detect.mutate()} loading={detect.isPending}>
          <ScanSearch className="h-4 w-4" /> {t('duplicates.detectBtn')}
        </Button>
      </div>

      {/*
        Duplicate show FOLDERS — two directories that are really one show. Distinct
        from the duplicate FILES below (the same episode ripped twice), and resolved
        differently: the operator picks the real path and the rest are re-homed.
      */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{t('shows.dupes.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('shows.dupes.subtitle')}</p>
        </div>
        <DuplicateShowsPanel />
      </section>

      <div className="border-t border-border/60" />

      {isLoading ? (
        <CenteredSpinner label={t('duplicates.loading')} />
      ) : isError ? (
        <ErrorState message={t('duplicates.error')} onRetry={() => refetch()} />
      ) : groups.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<Copy className="h-6 w-6" />}
              title={t('duplicates.emptyTitle')}
              description={t('duplicates.emptyBody')}
              action={
                <Button variant="secondary" onClick={() => detect.mutate()} loading={detect.isPending}>
                  <ScanSearch className="h-4 w-4" /> {t('duplicates.detectBtn')}
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <DuplicateGroupCard key={group.id} group={group} />
          ))}
          <Pagination page={page} pageSize={DUPES_PAGE_SIZE} total={data?.total ?? 0} onPage={setPage} busy={isFetching} />
        </div>
      )}
    </div>
  );
}

function DuplicateGroupCard({ group }: { group: MediaDuplicateGroup }) {
  const navigate = useNavigate();
  const { t } = useTranslation('media');
  // Client-side keep/remove marking (no destructive backend action exists).
  const [keepId, setKeepId] = useState<string | null>(group.suggestedKeepId);
  const title = useMemo(
    () => group.items[0]?.title ?? t('duplicates.groupFallbackTitle'),
    [group.items, t],
  );

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">{title}</p>
          <Badge variant="info">{duplicateReasonLabel(t, group.reason)}</Badge>
          <span className="text-xs text-muted-foreground">{t('common.items', { count: group.items.length })}</span>
        </div>

        <div className="overflow-x-auto scrollbar-thin">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[240px] pl-4">{t('duplicates.col.item')}</TableHead>
                <TableHead className="w-[90px]">{t('duplicates.col.year')}</TableHead>
                <TableHead className="w-[110px]">{t('duplicates.col.se')}</TableHead>
                <TableHead className="w-[110px]">{t('duplicates.col.resolution')}</TableHead>
                <TableHead className="w-[90px]">{t('duplicates.col.codec')}</TableHead>
                <TableHead className="w-[100px]">{t('duplicates.col.size')}</TableHead>
                <TableHead className="w-[200px] pr-4 text-right">{t('duplicates.col.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.items.map((item) => {
                const isKeep = keepId === item.id;
                return (
                  <TableRow key={item.id} className={isKeep ? '' : keepId ? 'opacity-60' : ''}>
                    <TableCell className="pl-4">
                      <div className="flex items-center gap-2">
                        {item.id === group.suggestedKeepId && (
                          <Star className="h-3.5 w-3.5 shrink-0 text-warning" aria-label={t('duplicates.suggestedKeepAria')} />
                        )}
                        <button
                          className="text-left font-medium hover:underline"
                          onClick={() => navigate(`/media/items/${item.id}`)}
                        >
                          {item.title}
                        </button>
                      </div>
                      <p className="truncate font-mono text-xs text-muted-foreground">{item.path}</p>
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{item.year ?? '—'}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {seasonEpisodeLabel(item.season, item.episode)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{item.bestResolution ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{item.bestCodec ?? '—'}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {formatBytes(item.totalSize)}
                    </TableCell>
                    <TableCell className="pr-4">
                      <div className="flex items-center justify-end gap-2">
                        {isKeep ? (
                          <Badge variant="success">{t('duplicates.keep')}</Badge>
                        ) : (
                          <>
                            <Button size="sm" variant="outline" onClick={() => setKeepId(item.id)}>
                              {t('duplicates.keepThis')}
                            </Button>
                            {keepId && <Badge variant="warning">{t('duplicates.remove')}</Badge>}
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">{t('duplicates.footnote')}</p>
      </CardContent>
    </Card>
  );
}
