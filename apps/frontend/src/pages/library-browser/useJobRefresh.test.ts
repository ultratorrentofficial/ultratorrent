import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { WS_EVENTS } from '@ultratorrent/shared';

const handlers = new Map<string, Array<(p: unknown) => void>>();
const invalidate = vi.fn();

vi.mock('@/lib/ws', () => ({
  wsClient: {
    on: (event: string, fn: (p: unknown) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((f) => f !== fn));
    },
  },
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: invalidate }) }));

import { useJobRefresh } from './useJobRefresh';

const emit = (event: string, payload: unknown) =>
  act(() => { (handlers.get(event) ?? []).forEach((f) => f(payload)); });

beforeEach(() => { handlers.clear(); invalidate.mockClear(); });

/**
 * The defect this exists for: a detached delete returned its jobId at 17:50:08
 * and finished at 17:50:13, so refreshing on the response captured the library
 * after ONE of thirty-five items — and never refreshed again.
 */
describe('useJobRefresh', () => {
  it('does not refresh until the watched job settles', () => {
    const { result } = renderHook(() => useJobRefresh(['library-browser']));
    act(() => result.current('job-1'));
    expect(invalidate).not.toHaveBeenCalled();

    emit(WS_EVENTS.JOB_COMPLETED, { jobId: 'job-1' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['library-browser'] });
  });

  it('ignores jobs this surface did not start', () => {
    // The channel carries every job on the install; an unrelated subtitle scan
    // must not refetch a library grid.
    renderHook(() => useJobRefresh(['library-browser']));
    emit(WS_EVENTS.JOB_COMPLETED, { jobId: 'someone-elses' });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('refreshes on failure and cancellation too', () => {
    // A job that died partway still changed the library.
    for (const [i, event] of [WS_EVENTS.JOB_FAILED, WS_EVENTS.JOB_CANCELLED].entries()) {
      invalidate.mockClear();
      const { result } = renderHook(() => useJobRefresh(['library-browser']));
      act(() => result.current(`job-${i}`));
      emit(event, { jobId: `job-${i}` });
      expect(invalidate).toHaveBeenCalledTimes(1);
    }
  });

  it('refreshes once per job, not once per later event', () => {
    const { result } = renderHook(() => useJobRefresh(['library-browser']));
    act(() => result.current('job-1'));
    emit(WS_EVENTS.JOB_COMPLETED, { jobId: 'job-1' });
    emit(WS_EVENTS.JOB_COMPLETED, { jobId: 'job-1' });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('tolerates an event with no job id', () => {
    renderHook(() => useJobRefresh(['library-browser']));
    expect(() => emit(WS_EVENTS.JOB_COMPLETED, {})).not.toThrow();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
