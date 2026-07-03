import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DirectoryPicker } from './PathPicker';

vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => false }),
}));

vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    files: {
      root: vi.fn().mockResolvedValue({
        root: '/downloads',
        configured: null,
        hardRoots: ['/downloads'],
        exists: true,
        readable: true,
        writable: true,
      }),
      browse: vi.fn((path = '/') =>
        Promise.resolve({
          path,
          roots: ['/downloads'],
          items:
            path === '/'
              ? [
                  { name: 'movies', path: '/movies', isDirectory: true, size: 0, modifiedAt: null },
                  { name: 'tv', path: '/tv', isDirectory: true, size: 0, modifiedAt: null },
                ]
              : [{ name: 'action', path: `${path}/action`, isDirectory: true, size: 0, modifiedAt: null }],
        }),
      ),
      createFolder: vi.fn(),
    },
  },
}));

import { api } from '@/lib/api';

function renderPicker(onSelect = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <DirectoryPicker open onClose={() => {}} onSelect={onSelect} />
    </QueryClientProvider>,
  );
  return { onSelect };
}

describe('DirectoryPicker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists directories under the root', async () => {
    renderPicker();
    expect(await screen.findByText('movies')).toBeInTheDocument();
    expect(screen.getByText('tv')).toBeInTheDocument();
    expect(screen.getByTitle('Root folder')).toBeInTheDocument();
  });

  it('selecting the current folder returns the absolute root path', async () => {
    const { onSelect } = renderPicker();
    await screen.findByText('movies');
    fireEvent.click(screen.getByRole('button', { name: /select this folder/i }));
    expect(onSelect).toHaveBeenCalledWith('/downloads');
  });

  it('navigates into a folder and confines the breadcrumb to the root', async () => {
    const { onSelect } = renderPicker();
    fireEvent.click(await screen.findByText('movies'));
    // Browsed into the subfolder…
    await waitFor(() => expect(api.files.browse).toHaveBeenCalledWith('/movies'));
    // …and selecting now yields the nested absolute path.
    fireEvent.click(screen.getByRole('button', { name: /select this folder/i }));
    expect(onSelect).toHaveBeenCalledWith('/downloads/movies');
  });

  it('going back to Root returns to the top of the allowed tree', async () => {
    renderPicker();
    fireEvent.click(await screen.findByText('movies'));
    await waitFor(() => expect(api.files.browse).toHaveBeenCalledWith('/movies'));
    fireEvent.click(screen.getByTitle('Root folder'));
    await waitFor(() => expect(screen.getByText('tv')).toBeInTheDocument());
  });
});
