import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type MediaAnalyticsDrill, type MediaAnalyticsFilter } from '@/lib/api';
import { Drawer, DrawerBody, DrawerHeader } from '@/components/ui/drawer';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { formatDateTime } from '@/lib/format';

const PAGE_SIZE = 25;

/** What the operator clicked, so the drawer can title itself. */
export interface DrilldownTarget {
  /** Heading — the chart's own label for the slice ("Roku", "1080p", "Wed 20:00"). */
  label: string;
  /** Which chart it came from, for the subtitle. */
  source: 'users' | 'devices' | 'resolution' | 'heatmap';
  drill: MediaAnalyticsDrill;
}

function seconds(v: number | null): string {
  if (!v) return '—';
  const m = Math.round(v / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The plays behind one slice of a chart.
 *
 * The row count here is the same number printed on the bar/cell that was clicked —
 * the server resolves a chart's *label* back to the raw values it folds (`1080p`
 * covers the raw `1080p`, `1080` and the junk `p`; the `Unknown` bar is NULL), so the
 * list can't quietly disagree with the chart the operator is looking at.
 */
export function PlayDrilldownDrawer({
  target,
  filter,
  onClose,
}: {
  target: DrilldownTarget | null;
  filter?: MediaAnalyticsFilter;
  onClose: () => void;
}) {
  const { t } = useTranslation('mediaServerAnalytics');
  const [page, setPage] = useState(1);

  // A new slice is a new list — never open on page 3 of the previous one.
  useEffect(() => setPage(1), [target?.label, target?.source]);

  const query = useQuery({
    queryKey: ['msa', 'plays', target?.drill, filter, page],
    queryFn: () => api.mediaServerAnalytics.reportPlays(filter, target!.drill, { page, pageSize: PAGE_SIZE }),
    enabled: !!target,
    placeholderData: keepPreviousData,
  });

  const data = query.data;

  return (
    <Drawer open={!!target} onClose={onClose} title={target?.label ?? ''} className="max-w-3xl">
      <DrawerHeader onClose={onClose}>
        <div className="min-w-0">
          <p className="truncate text-base font-semibold">{target?.label}</p>
          {target && (
            <p className="text-xs text-muted-foreground">
              {t('drilldown.subtitle', {
                source: t(`drilldown.source.${target.source}`),
                count: data?.total ?? 0,
              })}
            </p>
          )}
        </div>
      </DrawerHeader>
      <DrawerBody>
        {query.isLoading ? (
          <CenteredSpinner label={t('drilldown.loading')} />
        ) : query.isError ? (
          <ErrorState message={t('drilldown.loadError')} onRetry={() => void query.refetch()} />
        ) : !data || data.total === 0 ? (
          <EmptyState title={t('drilldown.empty')} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('watchHistory.col.title')}</TableHead>
                  <TableHead>{t('watchHistory.col.user')}</TableHead>
                  <TableHead>{t('watchHistory.col.device')}</TableHead>
                  <TableHead>{t('drilldown.col.quality')}</TableHead>
                  <TableHead>{t('watchHistory.col.watched')}</TableHead>
                  <TableHead>{t('watchHistory.col.when')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="max-w-[16rem] truncate" title={r.title}>
                      {r.title}
                      {r.libraryName && (
                        <span className="ml-1.5 text-xs text-muted-foreground">{r.libraryName}</span>
                      )}
                    </TableCell>
                    <TableCell>{r.userName ?? t('drilldown.unknown')}</TableCell>
                    <TableCell>
                      {r.device ?? t('drilldown.unknown')}
                      {r.client && <span className="ml-1.5 text-xs text-muted-foreground">{r.client}</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {r.resolution ?? t('drilldown.unknown')}
                      {r.playbackMethod && (
                        <span className="ml-1.5 text-xs text-muted-foreground">{r.playbackMethod}</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{seconds(r.watchedSeconds)}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(r.startedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="pt-3">
              <Pagination
                page={data.page}
                pageSize={data.pageSize}
                total={data.total}
                onPage={setPage}
                busy={query.isFetching}
              />
            </div>
          </>
        )}
      </DrawerBody>
    </Drawer>
  );
}
