import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AboutDialog } from './AboutDialog';

vi.mock('@/lib/api', () => ({
  api: {
    system: {
      version: vi.fn().mockResolvedValue({
        product: 'UltraTorrent',
        version: '9.9.9',
        edition: 'community',
        apiVersion: 'v1',
        gitSha: 'abcdef1234567890',
        buildTime: null,
        node: 'v22.0.0',
      }),
    },
  },
}));

function renderDialog(open = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AboutDialog open={open} onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AboutDialog', () => {
  it('renders the platform version and edition from the API', async () => {
    renderDialog();
    expect(await screen.findByText('v9.9.9')).toBeInTheDocument();
    expect(screen.getByText('UltraTorrent')).toBeInTheDocument();
    expect(screen.getByText('Community')).toBeInTheDocument();
    // Short commit sha is surfaced.
    expect(screen.getByText('abcdef1234')).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    renderDialog(false);
    expect(screen.queryByText('UltraTorrent')).not.toBeInTheDocument();
  });
});
