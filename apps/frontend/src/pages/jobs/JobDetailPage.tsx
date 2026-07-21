import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { api, type JobActionKind, type PlatformJobDetail } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { CenteredSpinner, EmptyState, ErrorState } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { statusVariant, jobDuration } from './jobStatus';

/** Available actions for the detail header, from status + capabilities. */
function detailActions(job: PlatformJobDetail): JobActionKind[] {
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

export function JobDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation('jobs');
  const td = t as unknown as (key: string, opts?: Record<string, unknown>) => string;
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const jobQ = useQuery({ queryKey: ['jobs', 'detail', id], queryFn: () => api.jobs.detail(id), refetchInterval: 4000, enabled: !!id });
  const eventsQ = useQuery({ queryKey: ['jobs', 'events', id], queryFn: () => api.jobs.events(id, { pageSize: 100 }), refetchInterval: 4000, enabled: !!id });
  const childrenQ = useQuery({ queryKey: ['jobs', 'children', id], queryFn: () => api.jobs.children(id), enabled: !!id });

  const act = useMutation({
    mutationFn: (action: JobActionKind) => api.jobs.action(id, action),
    onSuccess: (res, action) => {
      if (res.ok) toast.success(t('toast.actionDone', { action: td(`action.${action}`) }));
      else toast.error(t('toast.actionFailed', { action: td(`action.${action}`) }), res.reason ? td(`reason.${res.reason}`) : undefined);
      qc.invalidateQueries({ queryKey: ['jobs'] });
      if (res.jobId && res.jobId !== id) navigate(`/jobs/${res.jobId}`);
    },
  });

  if (jobQ.isLoading) return <CenteredSpinner label={t('title')} />;
  if (jobQ.isError || !jobQ.data) return <ErrorState message={t('reason.not_found')} onRetry={() => jobQ.refetch()} />;
  const job = jobQ.data;
  const events = eventsQ.data?.items ?? [];
  const children = childrenQ.data ?? [];

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="-ml-2">
        <ArrowLeft className="mr-1 h-4 w-4" /> {t('detail.back')}
      </Button>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight">{job.name ?? job.type}</h1>
            <Badge variant={statusVariant(job.status)} dot>{td(`status.${job.status}`)}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{job.type} · {job.moduleKey}</p>
        </div>
        <div className="flex gap-1.5">
          {detailActions(job).map((action) => (
            <Button key={action} size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate(action)}>
              {td(`action.${action}`)}
            </Button>
          ))}
        </div>
      </div>

      {job.status === 'running' && (
        <Progress value={job.progressPercent} showLabel />
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Facts */}
        <Card className="lg:col-span-1">
          <CardContent className="space-y-2 p-4 text-sm">
            <Fact label={t('detail.attempt', { attempt: job.attempt, max: job.maxAttempts })} value="" />
            <Fact label={t('column.source')} value={td(`source.${job.source}`, { defaultValue: job.source })} />
            <Fact label={t('column.priority')} value={String(job.priority)} />
            <Fact label={t('detail.createdAt')} value={new Date(job.createdAt).toLocaleString()} />
            {job.startedAt && <Fact label={t('detail.startedAt')} value={new Date(job.startedAt).toLocaleString()} />}
            {job.completedAt && <Fact label={t('detail.completedAt')} value={new Date(job.completedAt).toLocaleString()} />}
            <Fact label={t('column.duration')} value={jobDuration(job.startedAt, job.completedAt)} />
            {job.workerId && <Fact label={t('detail.worker')} value={job.workerId} />}
            {job.heartbeatAt && <Fact label={t('detail.heartbeat')} value={new Date(job.heartbeatAt).toLocaleString()} />}
            {job.resourceId && <Fact label={t('detail.resource')} value={`${job.resourceType ?? ''} ${job.resourceId}`} />}
          </CardContent>
        </Card>

        {/* Error / result / relationships */}
        <div className="space-y-4 lg:col-span-2">
          {job.errorMessage && (
            <Card>
              <CardContent className="p-4">
                <h2 className="mb-1 text-sm font-semibold text-destructive">{t('detail.error')}</h2>
                <p className="text-sm text-muted-foreground">{job.errorCode ? `${job.errorCode}: ` : ''}{job.errorMessage}</p>
              </CardContent>
            </Card>
          )}
          {(job.parentJobId || children.length > 0) && (
            <Card>
              <CardContent className="space-y-2 p-4">
                <h2 className="text-sm font-semibold">{t('detail.relationships')}</h2>
                {job.parentJobId && (
                  <Link to={`/jobs/${job.parentJobId}`} className="block text-sm text-primary hover:underline">
                    ↑ {t('detail.parent')}
                  </Link>
                )}
                {children.map((c) => (
                  <Link key={c.id} to={`/jobs/${c.id}`} className="flex items-center gap-2 text-sm hover:text-primary">
                    <Badge variant={statusVariant(c.status)}>{td(`status.${c.status}`)}</Badge>
                    <span className="truncate">{c.name ?? c.type}</span>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}
          {(job.inputSummary != null || job.resultSummary != null) && (
            <Card>
              <CardContent className="space-y-3 p-4">
                {job.inputSummary != null && <Json label={t('detail.input')} value={job.inputSummary} />}
                {job.resultSummary != null && <Json label={t('detail.result')} value={job.resultSummary} />}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Timeline / events */}
      <Card>
        <CardContent className="p-4">
          <h2 className="mb-3 text-sm font-semibold">{t('detail.timeline')}</h2>
          {events.length === 0 ? (
            <EmptyState title={t('empty.noEvents')} />
          ) : (
            <ol className="space-y-1.5">
              {events.map((ev) => (
                <li key={ev.id} className="flex items-start gap-3 text-sm">
                  <span className="w-16 shrink-0 tabular-nums text-xs text-muted-foreground">{new Date(ev.createdAt).toLocaleTimeString()}</span>
                  <Badge variant={ev.level === 'error' ? 'destructive' : ev.level === 'warning' ? 'warning' : ev.level === 'success' ? 'success' : 'secondary'}>
                    {ev.eventType}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {ev.sanitizedMessage ?? (ev.messageKey ?? '')}
                    {ev.progress != null ? ` · ${ev.progress}%` : ''}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      {value && <span className="text-right font-medium">{value}</span>}
    </div>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3>
      <pre className="overflow-x-auto rounded-lg bg-white/[0.03] p-2 text-xs">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
