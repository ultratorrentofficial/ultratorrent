import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { QuickCleanPanel } from './QuickCleanPanel';

const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), toast: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => toastSpy }));

const apiSpy = vi.hoisted(() => ({
  quickCleanCandidates: vi.fn(),
  bulkPreviewDuplicates: vi.fn(),
  bulkResolveDuplicates: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { media: apiSpy },
}));

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <QuickCleanPanel />
    </QueryClientProvider>,
  );
}

const candidates = {
  groups: [
    { id: 'g1', title: 'Movie A', reason: 'title_year', confidence: 95, fileCount: 2, recommendedItemId: 'i1', potentialSavingsBytes: 1_000_000, version: 1 },
    { id: 'g2', title: 'Movie B', reason: 'external_id', confidence: 99, fileCount: 3, recommendedItemId: 'i2', potentialSavingsBytes: 2_000_000, version: 1 },
  ],
  totalGroups: 2,
  totalFiles: 3,
  totalSavingsBytes: 3_000_000,
  cap: 100,
};

describe('QuickCleanPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiSpy.quickCleanCandidates.mockResolvedValue(candidates);
  });

  it('pre-selects nothing — the default is an empty basket, not a full one', async () => {
    renderPanel();
    // Both candidate groups render…
    expect(await screen.findByText('Movie A')).toBeInTheDocument();
    expect(screen.getByText('Movie B')).toBeInTheDocument();
    // …but no checkbox is checked, so the destructive default is "do nothing".
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.every((b) => b.getAttribute('aria-checked') === 'false')).toBe(true);
    // And the confirm/preview action is disabled until something is chosen.
    expect(screen.getByRole('button', { name: /preview/i })).toBeDisabled();
  });

  it('builds a real server plan before it will let you clean — no client-side delete list', async () => {
    apiSpy.bulkPreviewDuplicates.mockResolvedValue({
      succeeded: 1, failed: 0, totalSavingsBytes: 1_000_000, totalFiles: 1,
      results: [{ groupId: 'g1', ok: true, resolutionId: 'r1' }],
    });
    renderPanel();
    await screen.findByText('Movie A');

    fireEvent.click(screen.getByRole('checkbox', { name: /select.*Movie A/i }));
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));

    // The plan is the SERVER's; the panel sent group ids and got resolution ids back.
    await waitFor(() => expect(apiSpy.bulkPreviewDuplicates).toHaveBeenCalledWith(['g1']));
    // Confirm only appears once a plan exists, and resolves by the returned id.
    const confirm = await screen.findByRole('button', { name: /trash|clean|remove/i });
    fireEvent.click(confirm);
    await waitFor(() => expect(apiSpy.bulkResolveDuplicates).toHaveBeenCalledWith(['r1'], false));
  });

  it('keeps the selection after a partial run so the operator can see what remains', async () => {
    apiSpy.bulkPreviewDuplicates.mockResolvedValue({
      succeeded: 2, failed: 0, totalSavingsBytes: 3_000_000, totalFiles: 3,
      results: [
        { groupId: 'g1', ok: true, resolutionId: 'r1' },
        { groupId: 'g2', ok: true, resolutionId: 'r2' },
      ],
    });
    apiSpy.bulkResolveDuplicates.mockResolvedValue({
      succeeded: 1, failed: 1, reclaimedBytes: 1_000_000,
      results: [{ resolutionId: 'r1', ok: true }, { resolutionId: 'r2', ok: false }],
    });
    renderPanel();
    await screen.findByText('Movie A');

    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    const confirm = await screen.findByRole('button', { name: /trash|clean|remove/i });
    fireEvent.click(confirm);

    // Partial is surfaced as an ERROR, not a success with a footnote.
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
    expect(toastSpy.success).not.toHaveBeenCalled();
    // Selection is NOT cleared — the operator needs to see which groups are still there.
    expect(screen.getAllByRole('checkbox').some((b) => b.getAttribute('aria-checked') === 'true')).toBe(true);
  });

  it('shows an empty state when there is nothing safe to auto-clean', async () => {
    apiSpy.quickCleanCandidates.mockResolvedValue({ groups: [], totalGroups: 0, totalFiles: 0, totalSavingsBytes: 0, cap: 100 });
    renderPanel();
    // No candidate rows, and no preview affordance to mislead.
    await waitFor(() => expect(apiSpy.quickCleanCandidates).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /preview/i })).not.toBeInTheDocument();
  });
});
