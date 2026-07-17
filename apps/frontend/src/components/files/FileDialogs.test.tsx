import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MoveCopyDialog } from './FileDialogs';

vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => false }),
}));

const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), toast: vi.fn() }));

vi.mock('@/components/ui/toast', () => ({
  useToast: () => toastSpy,
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
      // Default: destination is clear, so the dialog transfers straight through.
      moveConflicts: vi.fn().mockResolvedValue({ destination: '/movies', conflicts: [], clean: [] }),
      resolveConflicts: vi.fn().mockResolvedValue({ operation: 'move', total: 1, succeeded: 1, failed: 0, results: [] }),
    },
  },
}));

import { api, type MoveConflictReport } from '@/lib/api';

/** A same-episode conflict the operator must resolve (source is the better release). */
function sameEpisodeConflict(): MoveConflictReport {
  return {
    destination: '/movies',
    clean: [],
    conflicts: [
      {
        source: {
          path: '/tv/a.mkv', name: 'Show.S01E01.1080p.x265-GRP.mkv', size: 200, modifiedAt: null,
          show: 'Show', season: 1, episode: 1, resolution: '1080p', source: 'WEB-DL', codec: 'x265',
          releaseGroup: 'GRP', proper: false, repack: false,
        },
        target: {
          path: '/movies/Show.S01E01.720p.x264-OLD.mkv', name: 'Show.S01E01.720p.x264-OLD.mkv', size: 150, modifiedAt: null,
          show: 'Show', season: 1, episode: 1, resolution: '720p', source: 'HDTV', codec: 'x264',
          releaseGroup: 'OLD', proper: false, repack: false,
        },
        kind: 'same_episode',
        verdict: 'source_better',
        verdictReasons: ['resolution 1080p > 720p'],
        recommended: 'replace',
        allowed: ['replace', 'keep_both', 'delete_source', 'skip'],
      },
    ],
  };
}

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

  it('preflights the destination, then sends the ROOT-RELATIVE path when it is clear', async () => {
    renderDialog();
    await pickMoviesFolder();

    fireEvent.click(screen.getByRole('button', { name: /^move$/i }));

    // The conflict preflight runs first, against the chosen destination.
    await waitFor(() => expect(api.files.moveConflicts).toHaveBeenCalledWith('move', ['/tv/episode.mkv'], '/movies'));
    await waitFor(() => expect(api.files.move).toHaveBeenCalled());
    // Root-relative — NOT '/downloads/movies', which the backend would re-base
    // onto the root and resolve to '/downloads/downloads/movies'.
    expect(api.files.move).toHaveBeenCalledWith('/tv/episode.mkv', '/movies');
  });

  it('copies to the browsed folder too', async () => {
    renderDialog({ mode: 'copy' });
    await pickMoviesFolder();

    fireEvent.click(screen.getByRole('button', { name: /^copy$/i }));

    await waitFor(() => expect(api.files.copy).toHaveBeenCalled());
    expect(api.files.copy).toHaveBeenCalledWith('/tv/episode.mkv', '/movies');
  });

  it('routes a clean multi-selection through the bulk endpoint with the same destination', async () => {
    renderDialog({ paths: ['/tv/a.mkv', '/tv/b.mkv'] });
    await pickMoviesFolder();

    fireEvent.click(screen.getByRole('button', { name: /^move$/i }));

    await waitFor(() => expect(api.files.bulk).toHaveBeenCalled());
    expect(api.files.bulk).toHaveBeenCalledWith({
      operation: 'move',
      paths: ['/tv/a.mkv', '/tv/b.mkv'],
      destination: '/movies',
    });
  });

  it('defaults to the folder the user is already browsing', async () => {
    renderDialog({ defaultDestination: '/movies' });
    fireEvent.click(screen.getByRole('button', { name: /^move$/i }));
    await waitFor(() => expect(api.files.move).toHaveBeenCalled());
    expect(api.files.move).toHaveBeenCalledWith('/tv/episode.mkv', '/movies');
  });

  /**
   * `/files/bulk` resolves 200 even when every item failed — the per-item errors
   * live in the body. Reporting a resolved promise as success meant a multi-select
   * move onto existing files claimed "Moved 2 items" while nothing had moved.
   */
  describe('bulk failures reported in a 200 body', () => {
    const conflict = (paths: string[]) => ({
      operation: 'move',
      total: paths.length,
      succeeded: 0,
      failed: paths.length,
      results: paths.map((path) => ({ path, ok: false, message: 'Destination already exists' })),
    });

    async function submitBulkMove() {
      renderDialog({ paths: ['/tv/a.mkv', '/tv/b.mkv'] });
      await pickMoviesFolder();
      fireEvent.click(screen.getByRole('button', { name: /^move$/i }));
    }

    it('reports a total failure as an error, not success', async () => {
      vi.mocked(api.files.bulk).mockResolvedValue(conflict(['/tv/a.mkv', '/tv/b.mkv']));
      await submitBulkMove();

      await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
      expect(toastSpy.success).not.toHaveBeenCalled();
      // The reason the backend gave must reach the user, deduped to one mention.
      expect(toastSpy.error).toHaveBeenCalledWith('Operation failed', 'Destination already exists');
    });

    it('keeps the dialog open on total failure so it can be retried', async () => {
      vi.mocked(api.files.bulk).mockResolvedValue(conflict(['/tv/a.mkv', '/tv/b.mkv']));
      const { onClose } = renderDialog({ paths: ['/tv/a.mkv', '/tv/b.mkv'] });
      await pickMoviesFolder();
      fireEvent.click(screen.getByRole('button', { name: /^move$/i }));

      await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
      expect(onClose).not.toHaveBeenCalled();
    });

    it('warns with a count when only some items moved', async () => {
      vi.mocked(api.files.bulk).mockResolvedValue({
        operation: 'move',
        total: 2,
        succeeded: 1,
        failed: 1,
        results: [
          { path: '/tv/a.mkv', ok: true },
          { path: '/tv/b.mkv', ok: false, message: 'Destination already exists' },
        ],
      });
      await submitBulkMove();

      await waitFor(() => expect(toastSpy.toast).toHaveBeenCalled());
      expect(toastSpy.success).not.toHaveBeenCalled();
      expect(toastSpy.toast).toHaveBeenCalledWith({
        level: 'warning',
        title: 'Completed 1 of 2',
        description: 'Destination already exists',
      });
    });

    it('still reports a clean bulk run as success', async () => {
      vi.mocked(api.files.bulk).mockResolvedValue({
        operation: 'move',
        total: 2,
        succeeded: 2,
        failed: 0,
        results: [
          { path: '/tv/a.mkv', ok: true },
          { path: '/tv/b.mkv', ok: true },
        ],
      });
      await submitBulkMove();

      await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith('Moved 2 items'));
      expect(toastSpy.error).not.toHaveBeenCalled();
    });
  });

  /**
   * The intelligence layer: when the destination already holds the file (or the
   * same episode in a different release), the operator gets a decision step
   * instead of a blind overwrite/error.
   */
  describe('conflict resolution', () => {
    async function submitAndReachResolveStep(paths = ['/tv/a.mkv']) {
      vi.mocked(api.files.moveConflicts).mockResolvedValue(sameEpisodeConflict());
      renderDialog({ paths, defaultDestination: '/movies' });
      fireEvent.click(screen.getByRole('button', { name: /^move$/i }));
      // The resolve step renders the episode heading and a Confirm button.
      await screen.findByText(/Show · S01E01/);
      return screen.getByRole('button', { name: /^confirm$/i });
    }

    it('shows the resolve step instead of transferring when a conflict is found', async () => {
      await submitAndReachResolveStep();
      // Nothing has been transferred — the preflight is read-only.
      expect(api.files.move).not.toHaveBeenCalled();
      expect(api.files.resolveConflicts).not.toHaveBeenCalled();
      // The recommended action (source is better → replace) is pre-selected.
      expect(screen.getByRole('radio', { name: /replace/i })).toHaveAttribute('aria-checked', 'true');
    });

    it('sends the recommended resolution with the target path on confirm', async () => {
      const confirm = await submitAndReachResolveStep();
      fireEvent.click(confirm);

      await waitFor(() => expect(api.files.resolveConflicts).toHaveBeenCalled());
      expect(api.files.resolveConflicts).toHaveBeenCalledWith({
        operation: 'move',
        destination: '/movies',
        permanent: false,
        items: [{ source: '/tv/a.mkv', resolution: 'replace', targetPath: '/movies/Show.S01E01.720p.x264-OLD.mkv' }],
      });
    });

    it('lets the operator override the recommendation', async () => {
      const confirm = await submitAndReachResolveStep();
      // Change the mind: keep the existing copy and drop the source instead.
      fireEvent.click(screen.getByRole('radio', { name: /keep existing, delete source/i }));
      fireEvent.click(confirm);

      await waitFor(() => expect(api.files.resolveConflicts).toHaveBeenCalled());
      expect(api.files.resolveConflicts).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [expect.objectContaining({ resolution: 'delete_source' })],
        }),
      );
    });

    it('exposes the permanent-delete toggle only when a destructive choice is selected', async () => {
      const confirm = await submitAndReachResolveStep();
      // 'replace' is destructive, so the toggle is present; turn it on.
      const permaToggle = screen.getByLabelText(/delete permanently/i);
      fireEvent.click(permaToggle);
      fireEvent.click(confirm);

      await waitFor(() => expect(api.files.resolveConflicts).toHaveBeenCalledWith(
        expect.objectContaining({ permanent: true }),
      ));
    });

    it('also transfers the non-conflicting sources alongside the resolved ones', async () => {
      vi.mocked(api.files.moveConflicts).mockResolvedValue({
        ...sameEpisodeConflict(),
        clean: ['/tv/clean.mkv'],
      });
      renderDialog({ paths: ['/tv/a.mkv', '/tv/clean.mkv'], defaultDestination: '/movies' });
      fireEvent.click(screen.getByRole('button', { name: /^move$/i }));
      const confirm = await screen.findByRole('button', { name: /^confirm$/i });
      fireEvent.click(confirm);

      await waitFor(() => expect(api.files.resolveConflicts).toHaveBeenCalled());
      // The clean file rides along through the plain bulk path.
      expect(api.files.bulk).toHaveBeenCalledWith({
        operation: 'move',
        paths: ['/tv/clean.mkv'],
        destination: '/movies',
      });
    });
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
