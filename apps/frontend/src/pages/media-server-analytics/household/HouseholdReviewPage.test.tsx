import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { HouseholdReviewPage } from './HouseholdReviewPage';
import { ToastProvider } from '@/components/ui/toast';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: { mediaServerAnalytics: { household: { reviews: vi.fn(), reviewDisposition: vi.fn() } } },
}));

const wrap = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter><HouseholdReviewPage /></MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

describe('HouseholdReviewPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists a review with its explainable reasons and dispositions it', async () => {
    vi.mocked(api.mediaServerAnalytics.household.reviews).mockResolvedValue([
      {
        id: 'r1', profileId: 'p1', subjectKey: 'p1', displayName: 'Gilberto Lopez', status: 'open',
        riskScore: 72, riskLevel: 'high',
        reasons: [{ code: 'simultaneous_residential_networks', delta: 30 }, { code: 'persistent_secondary_residential_network', delta: 20 }],
        reviewedBy: null, reviewedAt: null, createdAt: '2026-09-12T00:00:00Z',
      },
    ]);
    vi.mocked(api.mediaServerAnalytics.household.reviewDisposition).mockResolvedValue({} as never);
    wrap();

    await waitFor(() => expect(screen.getByText('Gilberto Lopez')).toBeInTheDocument());
    // The reason trace is shown (explainability), not just a bare score.
    expect(screen.getByText(/Simultaneous streams from two residential networks/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Confirm sharing'));
    await waitFor(() => expect(api.mediaServerAnalytics.household.reviewDisposition).toHaveBeenCalledWith('r1', 'confirmed_sharing'));
  });

  it('shows an empty state when nothing needs review', async () => {
    vi.mocked(api.mediaServerAnalytics.household.reviews).mockResolvedValue([]);
    wrap();
    await waitFor(() => expect(screen.getByText('Nothing to review')).toBeInTheDocument());
  });
});
