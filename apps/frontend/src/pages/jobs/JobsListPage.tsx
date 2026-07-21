import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Ban, Pause, Play, RefreshCw, RotateCcw, Search } from 'lucide-react';
import { api, type JobActionKind, type PlatformJobItem, type PlatformJobStatus } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Pagination } from '@/components/ui/pagination';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { statusVariant, jobDuration } from './jobStatus';

const PAGE_SIZE = 25;

/** Which actions a row offers, given its status + declared capabilities. */
function rowActions(job: PlatformJobItem): JobActionKind[] {
  const active = ['scheduled', 'queued', 'waiting', 'blocked', 'running', 'pausing', 'retrying'].includes(job.status);
  const terminal = ['completed', 'completed_with_warnings', 'failed', 'cancelled', 'skipped', 'expired'].includes(job.status);
  const out: JobActionKind[] = [];
  if (job.capabilities.cancellable && active) out.push('cancel');
  if (job.capabilities.pausable && job.status === 'running') out.push('pause');
  if (job.capabilities.resumable && job.status === 'paused') out.push('resume');
  if (job.capabilities.retryable && job.status === 'failed') out.push('retry');
  if (terminal) out.push('rerun');
  return out;
}

const ACTION_ICON: Record<JobActionKind, typeof Ban> = {
  cancel: Ban,
  pause: Pause,
  resume: Play,
  retry: RotateCcw,
  rerun: RefreshCw,
};

/**
 * The shared, route-driven job list. Filtered by the `?status=` query param (the
 * per-status tabs all render this one component), plus free-text search. Server-side
 * pagination/filter/sort; polls so it stays live. Row + bulk actions appear only
 * where the handler supports them and the user is authorized (the server re-checks).
 */
export function JobsListPage() {
  const { t } = useTranslation('jobs');
  const td = t as unknown as (key: string, opts?: Record<string, unknown>) => string;
  const toast = useToast();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const status = (params.get('status') as PlatformJobStatus | null) ?? undefined;
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const query = useQuery({
    queryKey: ['jobs', 'list', { status, page, search }],
    queryFn: () => api.jobs.listPlatform({ status, page, pageSize: PAGE_SIZE, search: search || undefined }),
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['jobs'] });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: JobActionKind }) => api.jobs.action(id, action),
    onSuccess: (res, vars) => {
      if (res.ok) toast.success(t('toast.actionDone', { action: td(`action.${vars.action}`) }));
      else toast.error(t('toast.actionFailed', { action: td(`action.${vars.action}`) }), res.reason ? td(`reason.${res.reason}`) : undefined);
      invalidate();
    },
    onError: (_e, vars) => toast.error(t('toast.actionFailed', { action: td(`action.${vars.action}`) })),
  });

  const bulk = useMutation({
    mutationFn: ({ action, ids }: { action: 'cancel' | 'retry' | 'rerun'; ids: string[] }) => api.jobs.bulk(action, ids),
    onSuccess: (res) => {
      toast[res.level === 'failed' ? 'error' : 'success'](
        t('bulk.result', { succeeded: res.succeeded.length, total: res.total }),
        res.failed.length ? t('bulk.partial', { failed: res.failed.length }) : undefined,
      );
      setSelected(new Set());
      invalidate();
    },
  });

  const jobs = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const allSelected = jobs.length > 0 && jobs.every((j) => selected.has(j.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(jobs.map((j) => j.id)));
  const selectedIds = useMemo(() => [...selected], [selected]);

  if (query.isLoading) return <CenteredSpinner label={t('title')} />;
  if (query.isError) return <ErrorState message={t('empty.hint')} onRetry={() => query.refetch()} />;

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[12rem]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder={t('filter.search')}
            className="pl-8"
            aria-label={t('filter.search')}
          />
        </div>
      </div>

      {/* Bulk toolbar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
          <span className="text-sm font-medium">{t('bulk.selected', { count: selected.size })}</span>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" variant="outline" disabled={bulk.isPending} onClick={() => bulk.mutate({ action: 'cancel', ids: selectedIds })}>
              {t('bulk.cancel')}
            </Button>
            <Button size="sm" variant="outline" disabled={bulk.isPending} onClick={() => bulk.mutate({ action: 'retry', ids: selectedIds })}>
              {t('bulk.retry')}
            </Button>
            <Button size="sm" variant="outline" disabled={bulk.isPending} onClick={() => bulk.mutate({ action: 'rerun', ids: selectedIds })}>
              {t('bulk.rerun')}
            </Button>
          </div>
        </div>
      )}

      {jobs.length === 0 ? (
        <EmptyState title={t('empty.noJobs')} description={t('empty.hint')} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="select all" />
                    </TableHead>
                    <TableHead>{t('column.status')}</TableHead>
                    <TableHead>{t('column.name')}</TableHead>
                    <TableHead className="hidden md:table-cell">{t('column.module')}</TableHead>
                    <TableHead className="w-32">{t('column.progress')}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t('column.source')}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t('column.duration')}</TableHead>
                    <TableHead className="text-right">{t('column.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => (
                    <TableRow key={job.id}>
                      <TableCell>
                        <input type="checkbox" checked={selected.has(job.id)} onChange={() => toggle(job.id)} aria-label={`select ${job.id}`} />
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(job.status)} dot>
                          {td(`status.${job.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[16rem]">
                        <Link to={`/jobs/${job.id}`} className="block truncate font-medium hover:text-primary">
                          {job.name ?? job.type}
                        </Link>
                        <span className="block truncate text-xs text-muted-foreground">{job.type}</span>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-muted-foreground">{job.moduleKey}</TableCell>
                      <TableCell>
                        {job.status === 'running' ? (
                          <Progress value={job.progressPercent} showLabel />
                        ) : (
                          <span className="text-xs text-muted-foreground tabular-nums">{job.progressPercent}%</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">{td(`source.${job.source}`, { defaultValue: job.source })}</TableCell>
                      <TableCell className="hidden lg:table-cell text-sm tabular-nums text-muted-foreground">{jobDuration(job.startedAt, job.completedAt)}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          {rowActions(job).map((action) => {
                            const Icon = ACTION_ICON[action];
                            return (
                              <Button
                                key={action}
                                size="icon"
                                variant="ghost"
                                title={td(`action.${action}`)}
                                aria-label={td(`action.${action}`)}
                                disabled={act.isPending}
                                onClick={() => act.mutate({ id: job.id, action })}
                              >
                                <Icon className="h-4 w-4" />
                              </Button>
                            );
                          })}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} busy={query.isFetching} />
    </div>
  );
}
