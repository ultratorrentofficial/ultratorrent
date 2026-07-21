import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WS_EVENTS } from '@ultratorrent/shared';
import { wsClient } from '@/lib/ws';

/** The permission-scoped job lifecycle events the Jobs Center reacts to. */
const JOB_EVENTS = [
  WS_EVENTS.JOB_CREATED, WS_EVENTS.JOB_QUEUED, WS_EVENTS.JOB_STARTED, WS_EVENTS.JOB_PROGRESS,
  WS_EVENTS.JOB_PHASE_CHANGED, WS_EVENTS.JOB_WARNING, WS_EVENTS.JOB_PAUSED, WS_EVENTS.JOB_RESUMED,
  WS_EVENTS.JOB_RETRYING, WS_EVENTS.JOB_COMPLETED, WS_EVENTS.JOB_FAILED, WS_EVENTS.JOB_CANCELLING,
  WS_EVENTS.JOB_CANCELLED, WS_EVENTS.JOB_STALLED, WS_EVENTS.JOB_CHILD_CREATED,
] as const;

/**
 * Live-updates the Jobs Center from the permission-scoped `jobs.*` WebSocket channel:
 * any job lifecycle event invalidates the jobs queries so lists/overview/detail refresh
 * immediately (no manual refresh), on top of the polling fallback. The server only sends
 * events the socket is authorized to see, so this can't surface a forbidden job.
 */
export function useJobsRealtime(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const invalidate = () => qc.invalidateQueries({ queryKey: ['jobs'] });
    const unsubscribers = JOB_EVENTS.map((event) => wsClient.on(event, invalidate));
    return () => unsubscribers.forEach((off) => off());
  }, [qc]);
}
