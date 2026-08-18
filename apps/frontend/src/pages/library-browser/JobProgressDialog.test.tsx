import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';

const apiSpy = vi.hoisted(() => ({ detail: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { jobs: { detail: apiSpy.detail } } }));

import { JobProgressDialog } from './JobProgressDialog';

const job = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  status: 'running',
  progressPercent: 25,
  progressCurrent: 2,
  progressTotal: 8,
  statusMessageKey: null,
  resultSummary: null,
  errorMessage: null,
  ...over,
});

function renderDialog(onSettled = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <JobProgressDialog jobId="job-1" title="Deleting media…" onSettled={onSettled} />
    </QueryClientProvider>,
  );
  return onSettled;
}

beforeEach(() => apiSpy.detail.mockReset());

/**
 * The defect: an 8-item delete finished server-side in 0.90 s while the grid
 * went on listing the deleted films for about a minute, because the refresh
 * waited on an event that never arrived. A delete that shows the media still
 * present does not read as "in progress", it reads as failed.
 */
describe('JobProgressDialog', () => {
  it('shows the job in progress rather than returning to a stale grid', async () => {
    apiSpy.detail.mockResolvedValue(job());
    renderDialog();

    expect(await screen.findByText('Deleting media…')).toBeInTheDocument();
    expect(await screen.findByText('2 of 8')).toBeInTheDocument();
  });

  it('prefers the count the server already reports', async () => {
    // The job carries its own "3/8"; recomputing it here could disagree with it.
    apiSpy.detail.mockResolvedValue(job({ statusMessageKey: '3/8' }));
    renderDialog();
    expect(await screen.findByText('3/8')).toBeInTheDocument();
  });

  it('hands back exactly once when the job completes', async () => {
    apiSpy.detail.mockResolvedValue(job({ status: 'completed', progressPercent: 100 }));
    const onSettled = renderDialog();

    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('hands back on failure too — a job that died still changed the library', async () => {
    apiSpy.detail.mockResolvedValue(job({ status: 'failed', errorMessage: 'disk full' }));
    const onSettled = renderDialog();
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    ));
  });

  it('keeps waiting when the job cannot be read, instead of closing', async () => {
    // The delete was accepted; dropping back to the grid on a failed poll is the
    // stale view this dialog exists to prevent.
    // One failure, then a poll that never settles: the assertion is about the
    // dialog staying put, and a repeating rejection would only add noise.
    // A poll that could not be read reports null — the component's own way of
    // saying "unknown this tick", so it keeps asking rather than erroring out.
    apiSpy.detail.mockResolvedValue(null);
    const onSettled = renderDialog();

    expect(await screen.findByText(/progress could not be read/i)).toBeInTheDocument();
    expect(onSettled).not.toHaveBeenCalled();
  });
});
