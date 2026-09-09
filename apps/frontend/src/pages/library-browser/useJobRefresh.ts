import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WS_EVENTS } from '@ultratorrent/shared';
import { api } from '@/lib/api';
import { wsClient } from '@/lib/ws';

/** Statuses after which nothing more will happen to the job. */
const TERMINAL = ['completed', 'failed', 'cancelled'];
const POLL_MS = 2000;
const POLL_CEILING_MS = 10 * 60 * 1000;

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
  /*
   * The key by VALUE. Call sites pass an array literal, so `queryKey` is a fresh
   * reference every render; depending on it directly would resubscribe and
   * re-create the callback on each one. This changes only when the contents do.
   */
  const keyId = JSON.stringify(queryKey);
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
    /*
     * `keyId`, not `queryKey`. Call sites pass an array literal, so the array is
     * a new reference on every render and depending on it directly would tear
     * down and re-establish the socket subscription each time. The stringified
     * form changes only when the key's CONTENTS change, which is the actual
     * condition for resubscribing.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyId is queryKey by value
  }, [qc, keyId]);

  /*
   * The event is the fast path, not the only one. It is delivered over a socket
   * that can be reconnecting, and it can be emitted in the window between the
   * response arriving and this watch being registered — in both cases nothing
   * invalidates and the view keeps a stale snapshot indefinitely. So a watched
   * job is also polled until it reaches a terminal state, which needs no
   * delivery guarantee and stops by itself. The interval is slow because this
   * is the safety net: the destructive paths that need immediacy show a
   * progress dialog and poll far faster.
   */
  return useCallback(
    (jobId: string) => {
      if (!jobId) return;
      watched.current.add(jobId);

      let elapsed = 0;
      const timer = setInterval(() => {
        elapsed += POLL_MS;
        // Give up long after any of these jobs would have finished; a watcher
        // that never stops is a background request loop nobody asked for.
        if (!watched.current.has(jobId) || elapsed > POLL_CEILING_MS) {
          clearInterval(timer);
          return;
        }
        void api.jobs
          .detail(jobId)
          .then((job) => {
            if (!TERMINAL.includes(job.status)) return;
            clearInterval(timer);
            // The event may have arrived first; invalidating twice is cheap,
            // missing it entirely is what this exists to prevent.
            watched.current.delete(jobId);
            qc.invalidateQueries({ queryKey });
          })
          .catch(() => undefined);
      }, POLL_MS);
    },
    // Same reasoning as the subscription above: by value, not by identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyId is queryKey by value
    [qc, keyId],
  );
}
