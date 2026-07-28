import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { api, type JobActionKind, type PlatformJobItem, type PlatformJobStatus } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Pagination } from '@/components/ui/pagination';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { statusVariant, jobDuration } from './jobStatus';
import { jobCapabilities } from './jobCapabilities';
import { ActionBar, type ActionHandler } from '@/actions/ActionBar';
import { ActionMenu } from '@/actions/ActionMenu';
import { useContextActions } from '@/actions/useContextActions';
import type { EntityRef } from '@ultratorrent/shared';

const PAGE_SIZE = 25;

/**
 * One row's actions, resolved from the CAMA catalogue.
 *
 * Replaces `rowActions(job)`, which derived buttons from status and applied no
 * permission check whatever — every viewer saw live Cancel and Retry controls
 * regardless of their grants. The catalogue applies the permission; the job
 * advertises what its state allows.
 *
 * A component per row rather than one resolution hoisted to the page, because
 * each row is its own selection. The catalogue is a single shared react-query
 * entry, so twenty-five rows still make one request.
 */
function JobRowActions({
  job,
  busy,
  onRun,
}: {
  job: PlatformJobItem;
  busy: boolean;
  onRun: (id: string, action: JobActionKind) => void;
}) {
  const selection = useMemo<EntityRef[]>(
    () => [{ type: 'job', id: job.id, capabilities: jobCapabilities(job) }],
    [job],
  );
  const { groups } = useContextActions({ selection });

  const handlers = useMemo<Record<string, ActionHandler>>(
    () => ({
      'jobs.cancel': () => onRun(job.id, 'cancel'),
      'jobs.pause': () => onRun(job.id, 'pause'),
      'jobs.resume': () => onRun(job.id, 'resume'),
      'jobs.retry': () => onRun(job.id, 'retry'),
      'jobs.rerun': () => onRun(job.id, 'rerun'),
    }),
    [job.id, onRun],
  );

  return <ActionMenu groups={groups} selection={selection} handlers={handlers} busy={busy} />;
}

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

  /*
   * Keep the selection to what is actually on screen.
   *
   * A selection is only meaningful against rows we hold: an action resolves
   * from each job's advertised capabilities, and a job on another page has none
   * we can read. Without this the bar would act on the loaded subset while the
   * user believed it covered everything they had ticked — acting on fewer items
   * than were selected, silently, which is the failure this framework exists to
   * avoid. Paging away therefore drops the selection rather than hiding it.
   */
  useEffect(() => {
    if (query.isFetching) return;
    setSelected((current) => {
      if (current.size === 0) return current;
      const onPage = new Set(jobs.map((j) => j.id));
      const kept = [...current].filter((id) => onPage.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [jobs, query.isFetching]);

  /*
   * The selection as entity refs, each carrying what that job can currently
   * have done to it. This is what lets one declaration serve a mixed selection:
   * an action is offered only when every selected job advertises it, so Cancel
   * over four running jobs and one finished one is correctly withheld rather
   * than silently cancelling four of five.
   */
  const jobSelection = useMemo<EntityRef[]>(
    () =>
      jobs
        .filter((j) => selected.has(j.id))
        .map((j) => ({ type: 'job' as const, id: j.id, capabilities: jobCapabilities(j) })),
    [jobs, selected],
  );

  const {
    groups: actionGroups,
    isLoading: actionsLoading,
    isError: actionsError,
  } = useContextActions({ selection: jobSelection });

  const actionHandlers = useMemo<Record<string, ActionHandler>>(
    () => ({
      // The *Bulk ids, not the single ones: the bulk routes require
      // jobs.bulk_manage on top of the verb, so they are separate declarations.
      'jobs.cancelBulk': (sel) => bulk.mutate({ action: 'cancel', ids: sel.map((e) => e.id) }),
      'jobs.retryBulk': (sel) => bulk.mutate({ action: 'retry', ids: sel.map((e) => e.id) }),
      'jobs.rerunBulk': (sel) => bulk.mutate({ action: 'rerun', ids: sel.map((e) => e.id) }),
    }),
    [bulk],
  );

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

      {/*
        The bulk toolbar, resolved from the CAMA catalogue.

        It previously offered Cancel, Retry and Rerun unconditionally, with no
        permission check of any kind and no regard for whether the selected jobs
        were in a state that admitted the action — a Cancel over five completed
        jobs was a live button. Now each selected job advertises what it can
        actually have done to it, and the action is offered only when EVERY one
        of them does.
      */}
      {selected.size > 0 && (
        <ActionBar
          groups={actionGroups}
          selection={jobSelection}
          handlers={actionHandlers}
          onClear={() => setSelected(new Set())}
          busy={bulk.isPending}
          isLoading={actionsLoading}
          isError={actionsError}
          primaryGroups={['maintenance']}
        />
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
                        <div className="flex items-center justify-end">
                          <JobRowActions
                            job={job}
                            busy={act.isPending}
                            onRun={(id, action) => act.mutate({ id, action })}
                          />
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
