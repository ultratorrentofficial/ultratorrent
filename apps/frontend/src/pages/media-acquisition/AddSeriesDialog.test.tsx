import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { ToastProvider } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { AddSeriesDialog } from './AddSeriesDialog';

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { seriesAcquisition: { search: vi.fn(), plan: vi.fn(), provision: vi.fn() } },
}));

// Most tests run as an operator who holds the override permission; the
// no-permission case overrides this per-test.
let hasPermission = true;
vi.mock('@/auth/AuthContext', () => ({ usePermission: () => hasPermission }));

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
  requiresInactiveConfirmation: false,
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
    hasPermission = true;
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

  it('an ended show blocks provisioning until the override is confirmed', async () => {
    vi.mocked(api.seriesAcquisition.search).mockResolvedValue([hit] as never);
    vi.mocked(api.seriesAcquisition.plan).mockResolvedValue({
      ...readyPlan,
      showStatus: { normalizedStatus: 'ended', inactive: true },
      requiresInactiveConfirmation: true,
      blockers: ['"The Expanse" has ended or been canceled — confirm monitoring for new releases before proceeding.'],
      ready: false,
    } as never);

    wrap();
    fireEvent.change(screen.getByPlaceholderText(/paste an IMDb/i), { target: { value: 'The Expanse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByText('The Expanse'));

    // The ended-show warning + confirm checkbox are shown; provision is disabled.
    await waitFor(() => expect(screen.getByText(/has ended or been canceled/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Add series' })).toBeDisabled();

    // Ticking the confirmation enables provisioning.
    fireEvent.click(screen.getByLabelText(/monitor this ended show/i));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add series' })).not.toBeDisabled());
  });

  it('without the override permission, an ended show cannot be confirmed', async () => {
    hasPermission = false;
    vi.mocked(api.seriesAcquisition.search).mockResolvedValue([hit] as never);
    vi.mocked(api.seriesAcquisition.plan).mockResolvedValue({
      ...readyPlan,
      showStatus: { normalizedStatus: 'ended', inactive: true },
      requiresInactiveConfirmation: true,
      blockers: ['ended'],
      ready: false,
    } as never);

    wrap();
    fireEvent.change(screen.getByPlaceholderText(/paste an IMDb/i), { target: { value: 'The Expanse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByText('The Expanse'));

    await waitFor(() => expect(screen.getByText(/requires the override permission/i)).toBeInTheDocument());
    expect(screen.queryByLabelText(/monitor this ended show/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Add series' })).toBeDisabled();
  });
});
