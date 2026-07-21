import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { DuplicateComparison } from './DuplicateComparison';

const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), toast: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => toastSpy }));

const apiSpy = vi.hoisted(() => ({
  duplicateGroup: vi.fn(),
  previewDuplicateCleanup: vi.fn(),
  previewDuplicateItemDeletion: vi.fn(),
  resolveDuplicateCleanup: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ ApiError: class ApiError extends Error {}, api: { media: apiSpy } }));

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DuplicateComparison groupId="g1" />
    </QueryClientProvider>,
  );
}

const candidate = (id: string, path: string) => ({
  id, title: 'Movie', year: 2019, season: null, episode: null, mediaType: 'movie',
  matchStatus: 'matched', libraryId: 'lib1', libraryName: 'Movies', path,
  addedAt: '', modifiedAt: '', externalIds: [], totalSize: 1000, qualityScore: 40,
  parsed: { container: null, resolution: null, videoCodec: null, audioCodec: null, hdr: null, releaseGroup: null },
  measured: { width: null, height: null, bitrateKbps: null, durationSec: null, audioChannels: null, frameRate: null },
});

const detail = {
  id: 'g1', groupKey: 'k', groupType: 'file', reason: 'title_year', status: 'open',
  confidence: 90, requiresReview: false, version: 1, potentialSavingsBytes: 1000,
  recommendedItemId: 'a', recommendation: null, warnings: null, ignoredReason: null,
  ignoredAt: null, resolvedAt: null, createdAt: '', suggestedKeepId: 'a',
  candidates: [candidate('a', '/m/a.mkv'), candidate('b', '/m/b.mkv'), candidate('c', '/m/c.mkv')],
};

describe('DuplicateComparison — per-file actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiSpy.duplicateGroup.mockResolvedValue(detail);
  });

  it('offers a Keep and a Delete button on every copy', async () => {
    renderIt();
    await screen.findByText('/m/a.mkv');
    // Three copies → three of each per-file action.
    expect(screen.getAllByRole('button', { name: /keep this copy and remove/i })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /delete only this copy/i })).toHaveLength(3);
  });

  it('Delete on one copy previews removing ONLY that copy, keeping the rest', async () => {
    apiSpy.previewDuplicateItemDeletion.mockResolvedValue({
      resolutionId: 'r1', groupId: 'g1', groupVersion: 1, deleteItemId: 'b',
      deletePath: '/m/b.mkv', survivorPaths: ['/m/a.mkv', '/m/c.mkv'],
      actions: [{ itemId: 'b', actionType: 'trash', sourcePath: '/m/b.mkv', fileSize: 1000 }],
      orphanedSubtitles: [], expectedSavingsBytes: 1000, blockers: [], warnings: [],
    });
    renderIt();
    await screen.findByText('/m/b.mkv');

    fireEvent.click(screen.getByRole('button', { name: 'Delete only this copy: /m/b.mkv' }));

    // The server plan is asked for by item id — the client never builds a delete list.
    await waitFor(() => expect(apiSpy.previewDuplicateItemDeletion).toHaveBeenCalledWith('g1', 'b'));
    // The dialog shows this copy going to Trash and the other two being kept.
    const dialog = await screen.findByRole('dialog');
    // /m/b.mkv appears twice in the dialog (the "removing" header and the trash row).
    expect(within(dialog).getAllByText('/m/b.mkv').length).toBeGreaterThan(0);
    // The two survivors are shown as kept.
    expect(within(dialog).getByText('/m/a.mkv')).toBeInTheDocument();
    expect(within(dialog).getByText('/m/c.mkv')).toBeInTheDocument();
  });

  it('Keep this on one copy previews collapsing the group to it', async () => {
    apiSpy.previewDuplicateCleanup.mockResolvedValue({
      resolutionId: 'r2', groupId: 'g1', groupVersion: 1, keepItemId: 'c', keepPath: '/m/c.mkv',
      actions: [
        { itemId: 'a', actionType: 'trash', sourcePath: '/m/a.mkv', fileSize: 1000 },
        { itemId: 'b', actionType: 'trash', sourcePath: '/m/b.mkv', fileSize: 1000 },
      ],
      orphanedSubtitles: [], expectedSavingsBytes: 2000, blockers: [], warnings: [],
    });
    renderIt();
    await screen.findByText('/m/c.mkv');

    fireEvent.click(screen.getByRole('button', { name: 'Keep this copy and remove the others: /m/c.mkv' }));

    await waitFor(() => expect(apiSpy.previewDuplicateCleanup).toHaveBeenCalledWith('g1', 'c'));
  });

  it('executes only the resolutionId the server returned — never a client file list', async () => {
    apiSpy.previewDuplicateItemDeletion.mockResolvedValue({
      resolutionId: 'r9', groupId: 'g1', groupVersion: 1, deleteItemId: 'b',
      deletePath: '/m/b.mkv', survivorPaths: ['/m/a.mkv', '/m/c.mkv'],
      actions: [{ itemId: 'b', actionType: 'trash', sourcePath: '/m/b.mkv', fileSize: 1000 }],
      orphanedSubtitles: [], expectedSavingsBytes: 1000, blockers: [], warnings: [],
    });
    apiSpy.resolveDuplicateCleanup.mockResolvedValue({ resolutionId: 'r9', status: 'completed', trashed: 1, skipped: 0, failed: 0, reclaimedBytes: 1000 });
    renderIt();
    await screen.findByText('/m/b.mkv');

    fireEvent.click(screen.getByRole('button', { name: 'Delete only this copy: /m/b.mkv' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /delete this copy/i }));

    await waitFor(() => expect(apiSpy.resolveDuplicateCleanup).toHaveBeenCalledWith('r9', false));
    expect(toastSpy.success).toHaveBeenCalled();
  });

  it('passes permanent=true when the operator opts to skip Trash', async () => {
    apiSpy.previewDuplicateItemDeletion.mockResolvedValue({
      resolutionId: 'r9', groupId: 'g1', groupVersion: 1, deleteItemId: 'b',
      deletePath: '/m/b.mkv', survivorPaths: ['/m/a.mkv', '/m/c.mkv'],
      actions: [{ itemId: 'b', actionType: 'trash', sourcePath: '/m/b.mkv', fileSize: 1000 }],
      orphanedSubtitles: [], expectedSavingsBytes: 1000, blockers: [], warnings: [],
    });
    apiSpy.resolveDuplicateCleanup.mockResolvedValue({ resolutionId: 'r9', status: 'completed', trashed: 1, skipped: 0, failed: 0, reclaimedBytes: 1000 });
    renderIt();
    await screen.findByText('/m/b.mkv');

    fireEvent.click(screen.getByRole('button', { name: 'Delete only this copy: /m/b.mkv' }));
    const dialog = await screen.findByRole('dialog');
    // Tick "delete permanently", then confirm.
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /delete permanently/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: /delete permanently/i }));

    await waitFor(() => expect(apiSpy.resolveDuplicateCleanup).toHaveBeenCalledWith('r9', true));
  });

  it('previews only the media file — no sidecar/orphaned-subtitle sections', async () => {
    // The cleanup removes only the media file now; the dialog should not surface
    // sidecar badges or an orphaned-subtitles panel.
    apiSpy.previewDuplicateItemDeletion.mockResolvedValue({
      resolutionId: 'r1', groupId: 'g1', groupVersion: 1, deleteItemId: 'b',
      deletePath: '/m/b.mkv', survivorPaths: ['/m/a.mkv', '/m/c.mkv'],
      actions: [{ itemId: 'b', actionType: 'trash', sourcePath: '/m/b.mkv', fileSize: 1000 }],
      orphanedSubtitles: [], expectedSavingsBytes: 1000, blockers: [], warnings: [],
    });
    renderIt();
    await screen.findByText('/m/b.mkv');
    fireEvent.click(screen.getByRole('button', { name: 'Delete only this copy: /m/b.mkv' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/only the media file is removed/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/orphaned/i)).not.toBeInTheDocument();
  });

  it('surfaces a server blocker instead of letting the delete proceed', async () => {
    apiSpy.previewDuplicateItemDeletion.mockResolvedValue({
      resolutionId: 'r3', groupId: 'g1', groupVersion: 1, deleteItemId: 'a', deletePath: '/library',
      survivorPaths: ['/m/b.mkv'], actions: [], orphanedSubtitles: [], expectedSavingsBytes: 0,
      blockers: ['"/library" is a library root, not a media file — refusing to delete it.'], warnings: [],
    });
    renderIt();
    await screen.findByText('/m/a.mkv');

    fireEvent.click(screen.getByRole('button', { name: 'Delete only this copy: /m/a.mkv' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/library root/i)).toBeInTheDocument();
    // The confirm button is disabled while blocked.
    expect(within(dialog).getByRole('button', { name: /delete this copy/i })).toBeDisabled();
  });
});
