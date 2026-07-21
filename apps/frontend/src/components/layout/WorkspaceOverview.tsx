import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import type { JobSummary } from '@/lib/api';
import { ModuleHub } from '@/components/layout/ModuleHub';
import { usePaletteProviders } from '@/components/layout/usePaletteProviders';
import { useWorkspaceJobs } from '@/components/layout/useWorkspaceJobs';
import { WORKSPACE_ACTION_IDS, WORKSPACE_JOB_SUBSYSTEMS } from '@/components/layout/workspace-config';
import type { NavGroup } from '@/components/layout/navigation';
import { cn } from '@/lib/utils';

/**
 * A workspace's **Overview** — its landing page. Composes the workspace's Quick Actions,
 * its navigable pages (the {@link ModuleHub} tile grid), and a live Active-Jobs widget
 * for workspaces that run background work. Everything is built from RBAC/module-filtered
 * data, so it never surfaces an action or job the user can't see. This is the page behind
 * `/hub/:workspaceId`.
 */
export function WorkspaceOverview({ group }: { group: NavGroup }) {
  const { actions } = usePaletteProviders();
  const actionIds = WORKSPACE_ACTION_IDS[group.id] ?? [];
  const quickActions = useMemo(
    () => actionIds.map((id) => actions.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a),
    [actionIds, actions],
  );
  const subsystems = WORKSPACE_JOB_SUBSYSTEMS[group.id];
  const { jobs, isLoading } = useWorkspaceJobs(subsystems);

  return (
    <div className="space-y-6">
      {quickActions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {quickActions.map((a) => {
            const Icon = a.icon;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => a.run()}
                className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2 text-sm font-medium transition-colors hover:border-primary/40 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {Icon && <Icon className="h-4 w-4 text-primary" />}
                {a.label}
              </button>
            );
          })}
        </div>
      )}

      <ModuleHub group={group} />

      {subsystems && <WorkspaceJobsWidget jobs={jobs} loading={isLoading} />}
    </div>
  );
}

/** A compact list of the workspace's active background jobs. */
function WorkspaceJobsWidget({ jobs, loading }: { jobs: JobSummary[]; loading: boolean }) {
  const { t } = useTranslation('shell');
  return (
    <section className="rounded-xl border border-border/60 bg-card/40 p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold">{t('workspace.activeJobs')}</h2>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        {jobs.length > 0 && (
          <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
            {jobs.length}
          </span>
        )}
      </div>
      {jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('workspace.noActiveJobs')}</p>
      ) : (
        <ul className="space-y-1.5">
          {jobs.map((job) => (
            <li key={`${job.subsystem}:${job.id}`} className="flex items-center gap-3 text-sm">
              <StatusDot status={job.status} />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{job.type}</span>
                {job.label && <span className="text-muted-foreground"> · {job.label}</span>}
              </span>
              {job.progress != null && job.status === 'running' && (
                <span className="tabular-nums text-xs text-muted-foreground">{job.progress}%</span>
              )}
              <span className="shrink-0 text-xs capitalize text-muted-foreground">{job.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusDot({ status }: { status: JobSummary['status'] }) {
  const tone =
    status === 'running'
      ? 'bg-primary animate-pulse'
      : status === 'failed'
        ? 'bg-destructive'
        : status === 'completed'
          ? 'bg-success'
          : status === 'cancelled'
            ? 'bg-muted-foreground'
            : 'bg-warning';
  return <span className={cn('h-2 w-2 shrink-0 rounded-full', tone)} aria-hidden />;
}
