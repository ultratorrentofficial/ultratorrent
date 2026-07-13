import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MoveCopyDialog } from './FileDialogs';

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
              ? [{ name: 'movies', path: '/movies', isDirectory: true, size: 0, modifiedAt: null }]
              : [],
        }),
      ),
      createFolder: vi.fn(),
      move: vi.fn().mockResolvedValue({}),
      copy: vi.fn().mockResolvedValue({}),
      bulk: vi.fn().mockResolvedValue({}),
    },
  },
}));

import { api } from '@/lib/api';

function renderDialog(props: Partial<React.ComponentProps<typeof MoveCopyDialog>> = {}) {
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MoveCopyDialog
        open
        mode="move"
        paths={['/tv/episode.mkv']}
        defaultDestination="/"
        onClose={onClose}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onClose };
}

/** Browse to /movies in the picker and confirm it. */
async function pickMoviesFolder() {
  fireEvent.click(screen.getByRole('button', { name: /browse/i }));
  fireEvent.click(await screen.findByText('movies'));
  await waitFor(() => expect(api.files.browse).toHaveBeenCalledWith('/movies'));
  fireEvent.click(screen.getByRole('button', { name: /select this folder/i }));
}

describe('MoveCopyDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('has no free-text destination field — the path is browsed, not typed', () => {
    renderDialog();
    // The destination is surfaced read-only; typing into it must not be possible.
    const field = screen.getByLabelText(/destination folder/i);
    expect(field).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: /browse/i })).toBeInTheDocument();
  });

  it('sends the ROOT-RELATIVE destination chosen in the picker', async () => {
    renderDialog();
    await pickMoviesFolder();

    fireEvent.click(screen.getByRole('button', { name: /^move$/i }));

    await waitFor(() => expect(api.files.move).toHaveBeenCalled());
    // Root-relative — NOT '/downloads/movies', which the backend would re-base
    // onto the root and resolve to '/downloads/downloads/movies'.
    expect(api.files.move).toHaveBeenCalledWith('/tv/episode.mkv', '/movies', false);
  });

  it('copies to the browsed folder too', async () => {
    renderDialog({ mode: 'copy' });
    await pickMoviesFolder();

    fireEvent.click(screen.getByRole('button', { name: /^copy$/i }));

    await waitFor(() => expect(api.files.copy).toHaveBeenCalled());
    expect(api.files.copy).toHaveBeenCalledWith('/tv/episode.mkv', '/movies', false);
  });

  it('routes a multi-selection through the bulk endpoint with the same destination', async () => {
    renderDialog({ paths: ['/tv/a.mkv', '/tv/b.mkv'] });
    await pickMoviesFolder();

    fireEvent.click(screen.getByRole('button', { name: /^move$/i }));

    await waitFor(() => expect(api.files.bulk).toHaveBeenCalled());
    expect(api.files.bulk).toHaveBeenCalledWith({
      operation: 'move',
      paths: ['/tv/a.mkv', '/tv/b.mkv'],
      destination: '/movies',
      overwrite: false,
    });
  });

  it('defaults to the folder the user is already browsing', async () => {
    renderDialog({ defaultDestination: '/movies' });
    fireEvent.click(screen.getByRole('button', { name: /^move$/i }));
    await waitFor(() => expect(api.files.move).toHaveBeenCalled());
    expect(api.files.move).toHaveBeenCalledWith('/tv/episode.mkv', '/movies', false);
  });

  /**
   * Every Dialog listens for Escape on `window`. Before the escape-stack fix, a
   * single Escape inside the nested picker closed the picker AND the Move dialog
   * behind it, silently discarding the operation.
   */
  it('Escape inside the picker closes only the picker, not the Move dialog', async () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /browse/i }));
    await screen.findByText('movies');

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByText('movies')).not.toBeInTheDocument());
    // The Move dialog survived, and nobody told it to close.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^move$/i })).toBeInTheDocument();
  });
});
