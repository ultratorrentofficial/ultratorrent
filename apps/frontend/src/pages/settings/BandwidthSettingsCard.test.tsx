import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n'; // real translations so t() returns strings

vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { bandwidth: { get: vi.fn(), update: vi.fn() } },
}));

import { api } from '@/lib/api';
import { BandwidthSettingsCard } from './BandwidthSettingsCard';

const engine = (over: Record<string, unknown> = {}) => ({
  engineId: 'qb',
  mode: 'native',
  source: 'settings',
  maxDownloadRateKbps: 5000,
  maxUploadRateKbps: 1000,
  ...over,
});

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BandwidthSettingsCard />
    </QueryClientProvider>,
  );
}

describe('BandwidthSettingsCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the saved ceiling', async () => {
    vi.mocked(api.bandwidth.get).mockResolvedValue({
      settings: { maxDownloadRateKbps: 5000, maxUploadRateKbps: 1000 },
      engines: [engine()],
    } as never);

    renderCard();
    await waitFor(() => expect(screen.getByDisplayValue('5000')).toBeTruthy());
    expect(screen.getByDisplayValue('1000')).toBeTruthy();
  });

  /*
   * The distinction the whole feature rests on: no ceiling saved is not the same
   * as a ceiling of unlimited, and the screen must not show them the same way.
   */
  it('leaves the fields empty when no ceiling has been set', async () => {
    vi.mocked(api.bandwidth.get).mockResolvedValue({
      settings: null,
      engines: [engine({ source: 'unconfigured', maxDownloadRateKbps: null, maxUploadRateKbps: null })],
    } as never);

    renderCard();
    await waitFor(() => expect(screen.getByLabelText(/Maximum download/i)).toHaveProperty('value', ''));
    expect(screen.getByLabelText(/Maximum upload/i)).toHaveProperty('value', '');
  });

  it('sends empty fields as unlimited rather than as zero', async () => {
    vi.mocked(api.bandwidth.get).mockResolvedValue({
      settings: { maxDownloadRateKbps: 5000, maxUploadRateKbps: 1000 },
      engines: [engine()],
    } as never);
    vi.mocked(api.bandwidth.update).mockResolvedValue({ settings: null, engines: [] } as never);

    renderCard();
    await waitFor(() => expect(screen.getByDisplayValue('5000')).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/Maximum download/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Save bandwidth limits/i }));

    await waitFor(() =>
      expect(api.bandwidth.update).toHaveBeenCalledWith({
        maxDownloadRateKbps: null,
        maxUploadRateKbps: 1000,
      }),
    );
  });

  /*
   * The reason each engine is or is not capped comes from the server, so the
   * screen cannot disagree with what actually happened.
   */
  it('reports an engine the scheduler is governing instead of claiming the ceiling applies', async () => {
    vi.mocked(api.bandwidth.get).mockResolvedValue({
      settings: { maxDownloadRateKbps: 5000, maxUploadRateKbps: null },
      engines: [engine({ engineId: 'rt', mode: 'managed', source: 'scheduler' })],
    } as never);

    renderCard();
    await waitFor(() => expect(screen.getByText('Activity Scheduler')).toBeTruthy());
  });

  it('names an engine that cannot apply a global limit', async () => {
    vi.mocked(api.bandwidth.get).mockResolvedValue({
      settings: { maxDownloadRateKbps: 5000, maxUploadRateKbps: null },
      engines: [engine({ engineId: 'legacy', source: 'unsupported' })],
    } as never);

    renderCard();
    await waitFor(() => expect(screen.getByText(/do not reach them: legacy/i)).toBeTruthy());
  });

  it('says an observing engine was deliberately left alone', async () => {
    vi.mocked(api.bandwidth.get).mockResolvedValue({
      settings: { maxDownloadRateKbps: 5000, maxUploadRateKbps: null },
      engines: [engine({ engineId: 'rt', mode: 'observe', source: 'observing' })],
    } as never);

    renderCard();
    await waitFor(() => expect(screen.getByText(/Observing/i)).toBeTruthy());
  });
});
