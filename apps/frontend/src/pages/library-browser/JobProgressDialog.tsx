import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, type PlatformJobDetail } from '@/lib/api';
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';

/** Statuses after which nothing more will happen to the job. */
const TERMINAL = ['completed', 'failed', 'cancelled'];

/**
 * Hold the operator on screen while a destructive job runs, then hand the view
 * back refreshed.
 *
 * A bulk delete returns a job id immediately and erases the media afterwards,
 * so the grid can only be right once the job is done. It was refreshed from the
 * job's completion EVENT, which is correct when the event arrives and silent
 * when it does not: measured on a live host, an eight-item delete finished
 * server-side in 0.90 s while the grid went on showing the deleted films for
 * about a minute. Files gone, Plex already updated, browser still listing
 * them — which reads as a failed delete, and invites the operator to delete
 * them a second time.
 *
 * So the job is POLLED here rather than awaited passively. Polling is worth its
 * cost precisely because this is the case where being wrong is expensive: it
 * cannot miss an event it was not listening for, it works on a socket that
 * dropped and has not yet reconnected, and it ends by itself. The dialog is
 * also the honest answer to "why is nothing happening" — the work is real, it
 * takes as long as it takes, and hiding it behind an instantly-closed dialog is
 * what made the delay look like a fault.
 */
export function JobProgressDialog({
  jobId,
  title,
  onSettled,
}: {
  jobId: string;
  title: string;
  /** Called exactly once, with the finished job. */
  onSettled: (job: PlatformJobDetail) => void;
}) {
  const { t } = useTranslation('actions');
  const settled = useRef(false);

  const job = useQuery({
    queryKey: ['job', jobId],
    /*
     * A failed poll returns null rather than throwing. The job is still
     * running — the delete was accepted — so an error state that stops the
     * polling, or bubbles a retry storm, is the wrong shape for "could not read
     * it *this time*". Null means unknown, and the next tick asks again.
     */
    queryFn: () => api.jobs.detail(jobId).catch(() => null),
    /*
     * Fast enough that a sub-second job feels immediate, and it stops on its
     * own the moment the job reaches a terminal state — so this never becomes a
     * background poll nobody switched off.
     */
    refetchInterval: (query) =>
      TERMINAL.includes(query.state.data?.status ?? '') ? false : 400,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const status = job.data?.status;
  useEffect(() => {
    const data = job.data;
    if (!data || settled.current || !TERMINAL.includes(data.status)) return;
    settled.current = true;
    onSettled(data);
  }, [job.data, onSettled, status]);

  /*
   * A job that cannot be read is still a job that is running: the delete was
   * accepted, so closing on a failed poll would drop the operator back onto a
   * stale grid — the exact outcome this dialog exists to prevent. Say so and
   * keep polling instead.
   */
  const unreachable = job.isFetched && job.data === null;
  const done = job.data?.progressCurrent ?? null;
  const total = job.data?.progressTotal ?? null;
  const percent = job.data?.progressPercent ?? 0;

  return (
    <Dialog open onClose={() => undefined} className="max-w-md">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {unreachable ? t('jobProgress.unreachable') : t('jobProgress.body')}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 py-2">
        <Progress value={percent} showLabel />
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          {unreachable ? (
            <AlertTriangle className="h-3.5 w-3.5 text-warning" />
          ) : (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          )}
          {/* The server counts in items; `statusMessageKey` already carries the
              "3/8" it reports, so prefer it over recomputing the same thing. */}
          {job.data?.statusMessageKey
            ?? (done !== null && total !== null
              ? t('jobProgress.count', { done, total })
              : t('jobProgress.working'))}
        </p>
      </div>
    </Dialog>
  );
}
