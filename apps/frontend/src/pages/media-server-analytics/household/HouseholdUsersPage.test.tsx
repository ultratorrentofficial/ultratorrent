import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import { HouseholdUsersPage } from './HouseholdUsersPage';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: { mediaServerAnalytics: { household: { users: vi.fn(), user: vi.fn() } } },
}));

const wrap = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><HouseholdUsersPage /></MemoryRouter>
    </QueryClientProvider>,
  );

const usersPage = {
  items: [
    {
      profileId: 'p1', subjectKey: 'p1', displayName: 'jonathanxir',
      homeLocation: 'San Juan', homeIsp: 'DATACOM', homeConfidence: 89,
      additionalNetworks: 8, riskScore: 92, riskLevel: 'critical', hasOpenReview: true, lastEvaluatedAt: null,
    },
  ],
  total: 1, page: 1, pageSize: 25,
};

const net = (over: Record<string, unknown>) => ({
  id: 'n1', fingerprint: 'fp', asn: 1, isp: 'DATACOM', countryCode: 'PR', country: 'Puerto Rico',
  region: null, city: 'San Juan', networkType: 'residential', classificationSource: 'auto',
  playCount: 17, watchSeconds: 7200, distinctDays: 8, uniqueDevices: 2, confidence: 1,
  trusted: false, ignored: false, disposition: null, firstSeenAt: null, lastSeenAt: null, ...over,
});

describe('HouseholdUsersPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists users and reveals their networks inline on expand', async () => {
    vi.mocked(api.mediaServerAnalytics.household.users).mockResolvedValue(usersPage as never);
    vi.mocked(api.mediaServerAnalytics.household.user).mockResolvedValue({
      id: 'p1', subjectKey: 'p1', displayName: 'jonathanxir', homeNetworkId: 'home',
      homeConfidence: 89, homeLocked: false, riskScore: 92, riskLevel: 'critical', reasons: null,
      firstObservedAt: null, lastEvaluatedAt: null, notes: null,
      networks: [net({ id: 'home', city: 'San Juan' }), net({ id: 'n2', city: 'Arecibo' })],
      signals: [], reviews: [], linkedAccounts: [],
    } as never);

    wrap();
    await waitFor(() => expect(screen.getByText('jonathanxir')).toBeInTheDocument());
    // Not fetched until expanded (lazy).
    expect(api.mediaServerAnalytics.household.user).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /networks/i }));
    await waitFor(() => expect(api.mediaServerAnalytics.household.user).toHaveBeenCalledWith('p1'));
    // The second (non-home) network location shows up in the inline table.
    await waitFor(() => expect(screen.getByText('Arecibo, Puerto Rico')).toBeInTheDocument());
  });

  it('shows an empty state when no users are monitored', async () => {
    vi.mocked(api.mediaServerAnalytics.household.users).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 } as never);
    wrap();
    await waitFor(() => expect(screen.getByText(/no households/i)).toBeInTheDocument());
  });
});
