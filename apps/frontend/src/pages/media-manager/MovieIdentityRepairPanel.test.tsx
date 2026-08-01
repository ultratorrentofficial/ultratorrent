import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { MovieIdentityRepairPanel } from './MovieIdentityRepairPanel';

const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), toast: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => toastSpy }));

const apiSpy = vi.hoisted(() => ({
  previewMovieIdentityRepair: vi.fn(),
  applyMovieIdentityRepair: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { media: apiSpy },
}));

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MovieIdentityRepairPanel />
    </QueryClientProvider>,
  );
}

/** The live shapes: one re-identify, one clear, one ambiguous keep, one untouched. */
const PLAN = {
  contaminatedIds: 3,
  proposals: [
    {
      itemId: 'i-unchanged',
      path: '/m/Movies/The Maze Runner (2014)/The Maze Runner (2014) - 1080p.mp4',
      folderTitle: 'The Maze Runner',
      folderYear: 2014,
      current: { tmdb: '198663' },
      proposed: { tmdb: '198663' },
      action: 'unchanged' as const,
      ambiguous: false,
      reason: 'already correct',
    },
    {
      itemId: 'i-reidentify',
      path: '/m/Movies/Maze (2017)/The Maze Runner (2014) - 1080p.mp4',
      folderTitle: 'Maze',
      folderYear: 2017,
      current: { tmdb: '198663' },
      proposed: { tmdb: '464566' },
      action: 'reidentify' as const,
      ambiguous: false,
      reason: 'verified as "Maze" (2017)',
    },
    {
      itemId: 'i-clear',
      path: '/m/Movies/The Dark (2018)/The Dark Knight (2008) - 1080p.mp4',
      folderTitle: 'The Dark',
      folderYear: 2018,
      current: { tmdb: '155' },
      proposed: {},
      action: 'clear' as const,
      ambiguous: true,
      reason: '2 films share this title and year and none is the stored id — cleared',
    },
    {
      itemId: 'i-keep',
      path: '/m/Movies/Aladdin (1992)/Aladdin (1992) [720p].mp4',
      folderTitle: 'Aladdin',
      folderYear: 1992,
      current: { tmdb: '812' },
      proposed: { tmdb: '812' },
      action: 'unchanged' as const,
      ambiguous: true,
      reason: '3 films share this title and year; the stored id is one of them — kept',
    },
  ],
};

describe('MovieIdentityRepairPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiSpy.previewMovieIdentityRepair.mockResolvedValue(PLAN);
  });

  it('asks nothing of the provider until told to', async () => {
    // The preview is one provider call per affected folder. A panel that fires
    // that on mount turns opening a tab into a rate-limit incident.
    renderPanel();
    expect(await screen.findByRole('button', { name: /scan for contaminated/i })).toBeInTheDocument();
    expect(apiSpy.previewMovieIdentityRepair).not.toHaveBeenCalled();
  });

  it('scans on request and shows the folder, not the filename, as the identity', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /scan for contaminated/i }));
    await waitFor(() => expect(apiSpy.previewMovieIdentityRepair).toHaveBeenCalledTimes(1));
    // The folder is the trusted signal…
    expect(await screen.findByText('The Dark (2018)')).toBeInTheDocument();
    // …and the path is shown so the operator can see the filename disagrees.
    expect(
      screen.getByText('/m/Movies/The Dark (2018)/The Dark Knight (2008) - 1080p.mp4'),
    ).toBeInTheDocument();
  });

  it('puts the rows a human might disagree with first', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /scan for contaminated/i }));
    const rows = await screen.findAllByText(/^(The Dark|Aladdin|Maze|The Maze Runner) \(\d{4}\)$/);
    // Ambiguous ahead of everything, then the clear, then the change, untouched last.
    expect(rows.map((r) => r.textContent)).toEqual([
      'The Dark (2018)',
      'Aladdin (1992)',
      'Maze (2017)',
      'The Maze Runner (2014)',
    ]);
  });

  it('counts only what would actually change', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /scan for contaminated/i }));
    // Two of the four proposals change: one re-identify and one clear. The kept
    // ambiguous row and the already-correct one are not work.
    expect(await screen.findByRole('button', { name: /repair 2 identities/i })).toBeInTheDocument();
  });

  it('will not apply without a confirm step', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /scan for contaminated/i }));
    fireEvent.click(await screen.findByRole('button', { name: /repair 2 identities/i }));
    // Still nothing sent — the button opened a confirmation, it did not act.
    expect(apiSpy.applyMovieIdentityRepair).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /yes, repair them/i })).toBeInTheDocument();
  });

  it('sends NO plan when applying — the server re-previews and acts on its own findings', async () => {
    apiSpy.applyMovieIdentityRepair.mockResolvedValue({ reidentified: 1, cleared: 1, unchanged: 2 });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /scan for contaminated/i }));
    fireEvent.click(await screen.findByRole('button', { name: /repair 2 identities/i }));
    fireEvent.click(await screen.findByRole('button', { name: /yes, repair them/i }));
    await waitFor(() => expect(apiSpy.applyMovieIdentityRepair).toHaveBeenCalledTimes(1));
    // A repair for damage caused by writing a wrong id must not accept "write
    // this id" from a client.
    expect(apiSpy.applyMovieIdentityRepair).toHaveBeenCalledWith();
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalled());
  });

  it('says so plainly when there is nothing wrong', async () => {
    apiSpy.previewMovieIdentityRepair.mockResolvedValue({ contaminatedIds: 0, proposals: [] });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /scan for contaminated/i }));
    expect(await screen.findByText(/no contaminated ids/i)).toBeInTheDocument();
  });

  it('surfaces a failed scan instead of showing an empty all-clear', async () => {
    // "Nothing to repair" and "we could not check" must never look alike here.
    apiSpy.previewMovieIdentityRepair.mockRejectedValue(new Error('provider down'));
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /scan for contaminated/i }));
    expect(await screen.findByText(/could not check movie identities/i)).toBeInTheDocument();
  });
});
