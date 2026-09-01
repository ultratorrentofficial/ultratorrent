import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';

const testConnectionConfig = vi.fn();
const createConnection = vi.fn();

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    mediaServerAnalytics: {
      testConnectionConfig: (...a: unknown[]) => testConnectionConfig(...a),
      createConnection: (...a: unknown[]) => createConnection(...a),
      updateConnection: vi.fn(),
    },
  },
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { ConnectionFormDialog } from './ConnectionFormDialog';

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <ConnectionFormDialog existing={null} onClose={vi.fn()} onSaved={vi.fn()} />
    </QueryClientProvider>,
  );

describe('ConnectionFormDialog', () => {
  beforeEach(() => { testConnectionConfig.mockReset(); createConnection.mockReset(); });

  /**
   * The credential field must follow the server type. Showing all of them at
   * once is how a Plex token ends up in the API-key box.
   */
  it('shows an API key for Jellyfin and a token for Plex', () => {
    show();
    expect(screen.getByLabelText(/API key/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Server type/i), { target: { value: 'plex' } });
    expect(screen.getByLabelText(/Plex token/i)).toBeTruthy();
    expect(screen.queryByLabelText(/API key/i)).toBeNull();
  });

  it('asks Kodi for a username and password instead', () => {
    show();
    fireEvent.change(screen.getByLabelText(/Server type/i), { target: { value: 'kodi' } });
    expect(screen.getByLabelText(/Username/i)).toBeTruthy();
    expect(screen.getByLabelText(/Password/i)).toBeTruthy();
    expect(screen.queryByLabelText(/API key/i)).toBeNull();
  });

  it('tests the form itself, so a bad key never gets written', async () => {
    testConnectionConfig.mockResolvedValue({ reachable: true, message: 'Connected to Jellyfin.', version: '10.11.11' });
    show();
    fireEvent.change(screen.getByLabelText(/Server URL/i), { target: { value: 'http://host:8096' } });
    fireEvent.change(screen.getByLabelText(/API key/i), { target: { value: 'abc123' } });
    fireEvent.click(screen.getByRole('button', { name: /^Test$/i }));
    await waitFor(() => expect(testConnectionConfig).toHaveBeenCalledWith({
      kind: 'jellyfin',
      config: { baseUrl: 'http://host:8096', apiKey: 'abc123' },
    }));
    // Nothing persisted by testing.
    expect(createConnection).not.toHaveBeenCalled();
    await screen.findByText(/Connected to Jellyfin/i);
  });

  it('surfaces an unreachable result rather than letting it look fine', async () => {
    testConnectionConfig.mockResolvedValue({ reachable: false, message: 'Jellyfin responded with HTTP 401.' });
    show();
    fireEvent.change(screen.getByLabelText(/Server URL/i), { target: { value: 'http://host:8096' } });
    fireEvent.click(screen.getByRole('button', { name: /^Test$/i }));
    await screen.findByText(/HTTP 401/i);
  });

  it('sends only the credential the chosen type uses', async () => {
    createConnection.mockResolvedValue({ id: 'x' });
    show();
    fireEvent.change(screen.getByLabelText(/^Name$/i), { target: { value: 'MY-JF' } });
    fireEvent.change(screen.getByLabelText(/Server URL/i), { target: { value: 'http://host:8096' } });
    fireEvent.change(screen.getByLabelText(/API key/i), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(createConnection).toHaveBeenCalled());
    const body = createConnection.mock.calls[0][0];
    expect(body.config).toEqual({ baseUrl: 'http://host:8096', apiKey: 'k' });
    expect(body.config.token).toBeUndefined();
  });

  it('cannot be saved without a name and URL', () => {
    show();
    expect(screen.getByRole('button', { name: /^Save$/i })).toHaveProperty('disabled', true);
  });
});
