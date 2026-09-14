import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { ToastProvider } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { AddSeriesDialog } from './AddSeriesDialog';

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    seriesAcquisition: { search: vi.fn(), plan: vi.fn(), provision: vi.fn() },
    media: { listLibraries: vi.fn() },
  },
}));

const hit = { provider: 'imdb', externalIds: { imdb: 'tt3230854' }, title: 'The Expanse', year: 2015 };

const readyPlan = {
  mode: 'backfill_and_monitor',
  media: { title: 'The Expanse', year: 2015, mediaType: 'series', externalIds: { imdb: 'tt3230854' } },
  template: { id: 'dt1', name: 'Premium TV' },
  readiness: { ready: true, reason: 'Match preferences "HD" are ready' },
  existing: { watchlistItemId: null, status: null, rssRuleId: null },
  showStatus: { normalizedStatus: 'returning', inactive: false },
  requestedSeasons: null,
  willMonitor: true,
  willBackfill: true,
  targetLibrary: { id: 'tv1', name: 'TV Shows' },
  intakeAvailable: true,
  willUseIntake: true,
  blockers: [],
  ready: true,
};

function wrap() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <AddSeriesDialog open onClose={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('AddSeriesDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.media.listLibraries).mockResolvedValue([
      { id: 'tv1', name: 'TV Shows', kind: 'tv' },
      { id: 'tv2', name: 'TV Retro', kind: 'tv' },
    ] as never);
  });

  it('searches, selects, previews readiness, and provisions', async () => {
    vi.mocked(api.seriesAcquisition.search).mockResolvedValue([hit] as never);
    vi.mocked(api.seriesAcquisition.plan).mockResolvedValue(readyPlan as never);
    vi.mocked(api.seriesAcquisition.provision).mockResolvedValue({
      watchlistItemId: 'wl1',
      rssRuleId: 'r1',
      ruleEnabled: true,
      alreadyExisted: false,
      scan: { total: 10, owned: 6, missing: 4, unaired: 0 },
      excludedFromScope: 0,
      backfillJobId: 'job1',
      notes: [],
    } as never);

    wrap();
    fireEvent.change(screen.getByPlaceholderText(/paste an IMDb/i), { target: { value: 'The Expanse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    const result = await screen.findByText('The Expanse');
    fireEvent.click(result);

    // Readiness preview appears.
    await waitFor(() => expect(screen.getByText(/Ready to provision/i)).toBeInTheDocument());

    const provisionBtn = screen.getByRole('button', { name: 'Add series' });
    expect(provisionBtn).not.toBeDisabled();
    fireEvent.click(provisionBtn);

    await waitFor(() => expect(api.seriesAcquisition.provision).toHaveBeenCalledTimes(1));
    const body = vi.mocked(api.seriesAcquisition.provision).mock.calls[0][0];
    expect(body).toMatchObject({ title: 'The Expanse', mode: 'backfill_and_monitor', externalIds: { imdb: 'tt3230854' } });
  });

  it('an ended show offers only Backfill Only, and provisions as backfill_only', async () => {
    vi.mocked(api.seriesAcquisition.search).mockResolvedValue([hit] as never);
    // Status is independent of the chosen mode: a monitoring mode is blocked, but
    // Backfill Only is ready. The dialog auto-switches to backfill_only.
    vi.mocked(api.seriesAcquisition.plan).mockImplementation((async (input: any) =>
      input.mode === 'backfill_only'
        ? {
            ...readyPlan,
            mode: 'backfill_only',
            showStatus: { normalizedStatus: 'ended', inactive: true },
            willMonitor: false,
            willBackfill: true,
            blockers: [],
            ready: true,
          }
        : {
            ...readyPlan,
            showStatus: { normalizedStatus: 'ended', inactive: true },
            willMonitor: true,
            blockers: ['"The Expanse" has ended or been canceled — monitoring is not available; add it as Backfill Only.'],
            ready: false,
          }) as never);
    vi.mocked(api.seriesAcquisition.provision).mockResolvedValue({
      watchlistItemId: 'wl1', rssRuleId: null, ruleEnabled: false, alreadyExisted: false,
      scan: null, excludedFromScope: 0, backfillJobId: 'job1', notes: [],
    } as never);

    wrap();
    fireEvent.change(screen.getByPlaceholderText(/paste an IMDb/i), { target: { value: 'The Expanse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByText('The Expanse'));

    // The ended-show note is shown, and provisioning becomes available (as backfill_only).
    await waitFor(() => expect(screen.getByText(/can only be backfilled/i)).toBeInTheDocument());
    const provisionBtn = screen.getByRole('button', { name: 'Add series' });
    await waitFor(() => expect(provisionBtn).not.toBeDisabled());
    fireEvent.click(provisionBtn);

    await waitFor(() => expect(api.seriesAcquisition.provision).toHaveBeenCalledTimes(1));
    const body = vi.mocked(api.seriesAcquisition.provision).mock.calls[0][0];
    expect(body).toMatchObject({ mode: 'backfill_only' });
  });
});
