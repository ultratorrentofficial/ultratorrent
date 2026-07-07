import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n'; // real translations so t() returns strings

vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }), // full access in these tests
}));
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    prowlarr: {
      get: vi.fn(),
      update: vi.fn(),
      test: vi.fn(),
      open: vi.fn(),
    },
  },
}));

import { api } from '@/lib/api';
import { ProwlarrSettingsCard } from './ProwlarrSettingsCard';

const settings = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  internalUrl: 'http://prowlarr:9696',
  publicUrl: 'http://localhost:9696',
  hasApiKey: true,
  apiKey: '••••••••',
  status: 'ok',
  statusMessage: null,
  version: '1.21.0',
  indexerCount: 4,
  lastCheckedAt: '2026-07-07T00:00:00.000Z',
  ...over,
});

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProwlarrSettingsCard />
    </QueryClientProvider>,
  );
}

describe('ProwlarrSettingsCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the stored settings with a masked API key and status badge', async () => {
    (api.prowlarr.get as any).mockResolvedValue(settings());
    renderCard();
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    const key = screen.getByLabelText('API key') as HTMLInputElement;
    expect(key.value).toBe('••••••••'); // never the plaintext
    const internal = screen.getByLabelText('Internal URL') as HTMLInputElement;
    expect(internal.value).toBe('http://prowlarr:9696');
  });

  it('does not resend the masked key when only the URL changed (write-only)', async () => {
    (api.prowlarr.get as any).mockResolvedValue(settings());
    (api.prowlarr.update as any).mockResolvedValue(settings());
    renderCard();
    await screen.findByText('Connected');
    fireEvent.change(screen.getByLabelText('Public URL'), { target: { value: 'http://nas:9696' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.prowlarr.update).toHaveBeenCalled());
    const body = (api.prowlarr.update as any).mock.calls[0][0];
    expect(body.publicUrl).toBe('http://nas:9696');
    expect(body).not.toHaveProperty('apiKey'); // untouched key not resent
  });

  it('clears the mask on focus so a new key can be typed and is sent', async () => {
    (api.prowlarr.get as any).mockResolvedValue(settings());
    (api.prowlarr.update as any).mockResolvedValue(settings());
    renderCard();
    await screen.findByText('Connected');
    const key = screen.getByLabelText('API key') as HTMLInputElement;
    fireEvent.focus(key);
    expect(key.value).toBe('');
    fireEvent.change(key, { target: { value: 'newkey' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.prowlarr.update).toHaveBeenCalled());
    expect((api.prowlarr.update as any).mock.calls[0][0].apiKey).toBe('newkey');
  });

  it('opens Prowlarr via the tracked endpoint (new tab)', async () => {
    (api.prowlarr.get as any).mockResolvedValue(settings());
    (api.prowlarr.open as any).mockResolvedValue({ url: 'http://localhost:9696' });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderCard();
    await screen.findByText('Connected');
    fireEvent.click(screen.getByRole('button', { name: /Open Prowlarr/i }));
    await waitFor(() => expect(api.prowlarr.open).toHaveBeenCalled());
    expect(openSpy).toHaveBeenCalledWith('http://localhost:9696', '_blank', expect.any(String));
    openSpy.mockRestore();
  });
});
