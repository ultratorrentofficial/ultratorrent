import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { ContextActionBar } from './ContextActionBar';

const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), toast: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => toastSpy }));

const apiSpy = vi.hoisted(() => ({ bulkItems: vi.fn(), scanLibrary: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { media: apiSpy } }));

const authSpy = vi.hoisted(() => ({ hasPermission: vi.fn((_p: string): boolean => true) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => authSpy }));

beforeEach(() => {
  vi.clearAllMocks();
  authSpy.hasPermission.mockReturnValue(true);
  apiSpy.bulkItems.mockResolvedValue({ jobId: 'j1', accepted: 2, missing: [] });
  apiSpy.scanLibrary.mockResolvedValue({ jobId: 'scan-1' });
});

function renderBar(selectedIds: string[], onClear = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ContextActionBar libraryId="lib-1" selectedIds={selectedIds} onClear={onClear} />
    </QueryClientProvider>,
  );
  return { onClear };
}

describe('ContextActionBar', () => {
  it('offers library work when nothing is selected', () => {
    renderBar([]);
    expect(screen.getByText('Nothing selected')).toBeInTheDocument();
    expect(screen.getByText('Scan library')).toBeInTheDocument();
    // Item operations are meaningless without items.
    expect(screen.queryByText('Refresh metadata')).not.toBeInTheDocument();
  });

  it('switches to item operations once something is selected', () => {
    renderBar(['a', 'b']);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByText('Refresh metadata')).toBeInTheDocument();
    expect(screen.queryByText('Scan library')).not.toBeInTheDocument();
  });

  it('sends the whole selection as ONE request', async () => {
    renderBar(['a', 'b']);
    fireEvent.click(screen.getByText('Refresh metadata'));
    await waitFor(() => expect(apiSpy.bulkItems).toHaveBeenCalledTimes(1));
    // Not one call per item: that would give no single job and one audit row each.
    expect(apiSpy.bulkItems).toHaveBeenCalledWith('metadata', ['a', 'b']);
  });

  it('says queued, not done, when the work became a job', async () => {
    renderBar(['a', 'b']);
    fireEvent.click(screen.getByText('Refresh metadata'));
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith('Queued for 2 items.'));
  });

  it('says applied for a synchronous operation', async () => {
    apiSpy.bulkItems.mockResolvedValue({ jobId: '', accepted: 2, missing: [] });
    renderBar(['a', 'b']);
    fireEvent.click(screen.getByText('Lock'));
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith('Applied to 2 items.'));
  });

  it('surfaces ids that resolved to nothing', async () => {
    // Acting on fewer items than were selected must not look like plain success.
    apiSpy.bulkItems.mockResolvedValue({ jobId: 'j1', accepted: 1, missing: ['ghost'] });
    renderBar(['a', 'ghost']);
    fireEvent.click(screen.getByText('Refresh metadata'));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith('1 item could not be found.'));
  });

  it('clears the selection after a successful run', async () => {
    const { onClear } = renderBar(['a']);
    fireEvent.click(screen.getByText('Lock'));
    await waitFor(() => expect(onClear).toHaveBeenCalled());
  });

  it('keeps the selection when the run failed', async () => {
    apiSpy.bulkItems.mockRejectedValue(new Error('nope'));
    const { onClear } = renderBar(['a']);
    fireEvent.click(screen.getByText('Lock'));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith('nope'));
    expect(onClear).not.toHaveBeenCalled();
  });

  it('hides actions the user has no permission for', () => {
    // Not the security boundary — the server guard is — but offering a button
    // that always fails is its own kind of lie.
    authSpy.hasPermission.mockImplementation((p: string) => p === 'media_manager.generate_nfo');
    renderBar(['a']);
    expect(screen.getByText('Generate NFO')).toBeInTheDocument();
    expect(screen.queryByText('Refresh metadata')).not.toBeInTheDocument();
    expect(screen.queryByText('Lock')).not.toBeInTheDocument();
  });

  it('scans the library it was given', async () => {
    renderBar([]);
    fireEvent.click(screen.getByText('Scan library'));
    await waitFor(() => expect(apiSpy.scanLibrary).toHaveBeenCalledWith('lib-1'));
  });
});
