import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, RotateCw, XCircle, ChevronRight, ChevronDown } from 'lucide-react';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { api, ApiError, type IntakeJob } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CenteredSpinner, EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';

/** Which states are worth a filter chip, in lifecycle order. */
const FILTERS = [
  'active', 'failed', 'quarantined', 'seeding', 'imported', 'archived', 'cancelled',
] as const;

/** Terminal or attention states get a colour; the rest are neutral. */
function toneOf(state: string): 'success' | 'destructive' | 'warning' | 'secondary' {
  if (state === 'failed') return 'destructive';
  if (state === 'quarantined') return 'warning';
  if (state === 'imported' || state === 'seeding' || state === 'archived') return 'success';
  return 'secondary';
}

/**
 * What the intake engine is doing, and what it did.
 *
 * The queue answers "is anything stuck", and the per-job timeline answers "what
 * happened to this one" — which is the question an operator actually has when
 * something did not appear in their library. The timeline is the same event
 * trail the engine writes for its own audit, so the screen cannot show a story
 * the database disagrees with.
 *
 * Failed and quarantined are separated deliberately, because they need
 * different actions: a failure is retried, a quarantine is looked at.
 */
export function IntakeDashboardPage() {
  const { t } = useTranslation('intake');
  const toast = useToast();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<string>('active');
  const [openJob, setOpenJob] = useState<string | null>(null);

  const summary = useQuery({
    queryKey: ['intake', 'summary'],
    queryFn: () => api.intake.summary(),
    // Something is usually moving; a stale count reads as a stalled queue.
    refetchInterval: 5000,
  });

  const jobs = useQuery({
    queryKey: ['intake', 'jobs', filter],
    queryFn: () => api.intake.jobs(filter === 'active' ? { active: true } : { state: filter }),
    refetchInterval: 5000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['intake', 'jobs'] });
    qc.invalidateQueries({ queryKey: ['intake', 'summary'] });
  };

  const retry = useMutation({
    mutationFn: (id: string) => api.intake.retry(id),
    onSuccess: () => { toast.success(t('dash.retried')); invalidate(); },
    onError: (e) => toast.error(t('dash.retryFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.intake.cancel(id),
    onSuccess: () => { toast.success(t('dash.cancelled')); invalidate(); },
    onError: (e) => toast.error(t('dash.cancelFailed'), e instanceof ApiError ? e.message : undefined),
  });

  const counts = summary.data?.byState ?? {};

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Inbox className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">{t('dash.title')}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t('dash.subtitle')}</p>
      </div>

      {/* Filters double as the queue summary — one row rather than a stat strip
          above a filter row saying the same numbers twice. */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const n = f === 'active' ? (summary.data?.active ?? 0) : (counts[f] ?? 0);
          return (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? 'primary' : 'outline'}
              onClick={() => setFilter(f)}
            >
              {t(`state.${f}` as never)}
              <span className="ml-1.5 tabular-nums opacity-70">{n}</span>
            </Button>
          );
        })}
      </div>

      {jobs.isLoading ? (
        <CenteredSpinner label={t('dash.loading')} />
      ) : jobs.isError ? (
        <ErrorState message={t('dash.loadFailed')} onRetry={() => jobs.refetch()} />
      ) : !jobs.data?.length ? (
        <EmptyState
          icon={<Inbox className="h-6 w-6" />}
          title={t('dash.emptyTitle')}
          description={t('dash.emptyBody')}
        />
      ) : (
        <div className="space-y-2">
          {jobs.data.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              open={openJob === job.id}
              onToggle={() => setOpenJob(openJob === job.id ? null : job.id)}
              onRetry={() => retry.mutate(job.id)}
              onCancel={() => cancel.mutate(job.id)}
              busy={retry.isPending || cancel.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function JobRow({
  job, open, onToggle, onRetry, onCancel, busy,
}: {
  job: IntakeJob;
  open: boolean;
  onToggle: () => void;
  onRetry: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation('intake');
  const name = job.sourcePath.slice(job.sourcePath.lastIndexOf('/') + 1);
  const terminal = ['archived', 'cancelled'].includes(job.state);

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center gap-3 px-3 py-2">
          <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left"
            aria-expanded={open} onClick={onToggle}>
            {open
              ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
            <span className="min-w-0">
              <span className="block truncate text-sm">{name}</span>
              <span className="block text-xs text-muted-foreground">
                {formatRelativeTime(job.createdAt)}
                {job.strategy ? ` · ${job.strategy}` : ''}
                {/* Attempts only appear once there has been more than one — a
                    quiet "1" on every row is noise. */}
                {job.attempts > 0 ? ` · ${t('dash.attempts', { count: job.attempts })}` : ''}
              </span>
            </span>
          </button>
          <Badge variant={toneOf(job.state)} dot>{t(`state.${job.state}` as never)}</Badge>
          {job.state === 'failed' && (
            <Button size="sm" variant="outline" onClick={onRetry} disabled={busy}>
              <RotateCw className="h-4 w-4" /> {t('dash.retry')}
            </Button>
          )}
          {!terminal && (
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
              <XCircle className="h-4 w-4" />
            </Button>
          )}
        </div>
        {open && <JobTimeline id={job.id} job={job} />}
      </CardContent>
    </Card>
  );
}

/**
 * The event trail for one intake.
 *
 * Fetched only when opened — a page of jobs must not pull every job's history
 * to render a list. This is the engine's own audit trail, not a reconstruction,
 * so what it shows is what happened.
 */
function JobTimeline({ id, job }: { id: string; job: IntakeJob }) {
  const { t } = useTranslation('intake');
  const detail = useQuery({ queryKey: ['intake', 'job', id], queryFn: () => api.intake.job(id) });

  if (detail.isLoading) return <Skeleton className="m-3 h-16" />;
  if (detail.isError) {
    return <p className="px-3 pb-3 text-xs text-destructive">{t('dash.timelineFailed')}</p>;
  }

  return (
    <div className="space-y-2 border-t border-border/60 px-3 py-2 text-xs">
      <div className="grid gap-1 sm:grid-cols-2">
        <p className="truncate text-muted-foreground">{t('dash.source')}: {job.sourcePath}</p>
        {job.importedPath && (
          <p className="truncate text-muted-foreground">{t('dash.imported')}: {job.importedPath}</p>
        )}
      </div>
      {/* Why a strategy was chosen — the question behind "why did this copy 40GB". */}
      {job.strategyReason && (
        <p className="text-muted-foreground">{job.strategy}: {job.strategyReason}</p>
      )}
      {job.lastError && <p className="text-destructive">{job.lastError}</p>}
      <div className="space-y-1 pt-1">
        {detail.data?.events.map((e) => (
          <div key={e.id} className="flex gap-2">
            <span className="w-36 shrink-0 tabular-nums text-muted-foreground/70">
              {formatDateTime(e.createdAt)}
            </span>
            <span className="w-32 shrink-0">{t(`state.${e.toState}` as never)}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
