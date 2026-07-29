import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WS_EVENTS } from '@ultratorrent/shared';
import { wsClient } from '@/lib/ws';

/**
 * Refresh a view when the job it started actually finishes.
 *
 * A detached bulk operation returns a `jobId` immediately and does the work
 * afterwards, so invalidating on the HTTP response invalidates *before*
 * anything has happened. Measured on a real delete: the POST returned at
 * 17:50:08 and the job ran until 17:50:13, so the refetch landed 5.7 seconds
 * early and captured the library after **one** of thirty-five items had been
 * processed. Nothing invalidated again, so the grid held that mid-job snapshot
 * indefinitely — and a delete of 35 that shows 34 still present does not read
 * as "in progress", it reads as broken.
 *
 * So the completion event is the signal, not the response. Only jobs this
 * surface started are watched: the `jobs.*` channel carries every job on the
 * install, and refetching a library grid because an unrelated subtitle scan
 * finished would be noise.
 */
export function useJobRefresh(queryKey: readonly unknown[]): (jobId: string) => void {
  const qc = useQueryClient();
  const watched = useRef(new Set<string>());

  useEffect(() => {
    const seen = watched.current;
    const onSettled = (payload: { jobId?: string }) => {
      if (!payload?.jobId || !seen.has(payload.jobId)) return;
      seen.delete(payload.jobId);
      qc.invalidateQueries({ queryKey });
    };
    // Failed and cancelled matter as much as completed: a job that died partway
    // still changed the library, and leaving the stale view is how a partial
    // result becomes invisible.
    const offs = [WS_EVENTS.JOB_COMPLETED, WS_EVENTS.JOB_FAILED, WS_EVENTS.JOB_CANCELLED].map(
      (event) => wsClient.on(event, onSettled as never),
    );
    return () => offs.forEach((off) => off());
    // The key is a literal at every call site; stringified so a fresh array
    // identity each render does not resubscribe on every render.
  }, [qc, JSON.stringify(queryKey)]);

  return useCallback((jobId: string) => {
    if (jobId) watched.current.add(jobId);
  }, []);
}
