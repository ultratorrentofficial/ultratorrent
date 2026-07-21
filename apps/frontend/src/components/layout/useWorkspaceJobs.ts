import { useQuery } from '@tanstack/react-query';
import { api, type JobSubsystem, type JobSummary } from '@/lib/api';

/**
 * Active (queued/running) jobs for a workspace's Jobs widget. The `/jobs` aggregator is
 * already RBAC-scoped server-side, so this only ever returns jobs the user may view;
 * we then narrow to the workspace's own subsystems (`'all'` for the System view). Polls
 * while mounted so a running scan/import updates live. Disabled when the workspace has
 * no job subsystems.
 */
export function useWorkspaceJobs(subsystems: JobSubsystem[] | 'all' | undefined): {
  jobs: JobSummary[];
  isLoading: boolean;
  isError: boolean;
} {
  const enabled = subsystems === 'all' || (Array.isArray(subsystems) && subsystems.length > 0);
  const key = subsystems === 'all' ? 'all' : (subsystems ?? []).join(',');
  const query = useQuery({
    queryKey: ['jobs', 'active', key],
    queryFn: () => api.jobs.list({ active: true, limit: 25 }),
    enabled,
    refetchInterval: 5000,
    staleTime: 3000,
  });
  const all = query.data?.jobs ?? [];
  const jobs =
    subsystems === 'all' ? all : all.filter((j) => (subsystems ?? []).includes(j.subsystem));
  return { jobs, isLoading: query.isLoading, isError: query.isError };
}
