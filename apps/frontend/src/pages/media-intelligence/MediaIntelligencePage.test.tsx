import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { MediaIntelligencePage } from './MediaIntelligencePage';

/**
 * The claims worth pinning are the honest-reporting ones, because they are the
 * ones a later refactor would quietly break: a null must never render as a
 * zero, an unanalyzed library must say so rather than look empty-and-healthy,
 * and the page must state that it only observes.
 */

const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), toast: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => toastSpy }));

const intelSpy = vi.hoisted(() => ({
  overview: vi.fn(),
  list: vi.fn(),
  rebuild: vi.fn(),
}));
const mediaSpy = vi.hoisted(() => ({ listLibraries: vi.fn() }));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { mediaIntelligence: intelSpy, media: mediaSpy },
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MediaIntelligencePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const emptyCounts = { info: 0, opportunity: 0, warning: 0, error: 0, critical: 0 };

const overview = {
  analyzed: 2,
  byHealth: { healthy: 1, attention: 1, degraded: 0, critical: 0, unknown: 0 },
  byFindingCode: [
    { code: 'EPISODES_MISSING', domain: 'completeness', severity: 'warning', count: 1 },
  ],
  lastCalculatedAt: '2026-09-15T00:00:00.000Z',
  rebuilding: false,
};

const rows = {
  items: [
    {
      entityType: 'series',
      entityId: 'show-1',
      title: 'Breaking Bad',
      year: 2008,
      libraryId: 'lib-1',
      libraryName: 'TV Shows',
      health: 'attention',
      healthScore: 70,
      findingCounts: { ...emptyCounts, warning: 1 },
      totalBytes: 1_000_000,
      missingCount: 3,
      lastPlayedAt: null,
      calculatedAt: '2026-09-15T00:00:00.000Z',
    },
    {
      entityType: 'movie',
      entityId: 'mov-1',
      title: 'Heat',
      year: 1995,
      libraryId: 'lib-2',
      libraryName: 'Movies',
      health: 'healthy',
      healthScore: 100,
      findingCounts: { ...emptyCounts },
      // Not applicable to a movie — must NOT be rendered as 0.
      missingCount: null,
      totalBytes: null,
      lastPlayedAt: null,
      calculatedAt: '2026-09-15T00:00:00.000Z',
    },
  ],
  total: 2,
  page: 1,
  pageSize: 50,
};

describe('MediaIntelligencePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    intelSpy.overview.mockResolvedValue(overview);
    intelSpy.list.mockResolvedValue(rows);
    mediaSpy.listLibraries.mockResolvedValue([{ id: 'lib-1', name: 'TV Shows' }]);
  });

  it('lists analyzed titles with their health', async () => {
    renderPage();
    expect(await screen.findByText('Breaking Bad')).toBeInTheDocument();
    expect(screen.getByText('Heat')).toBeInTheDocument();
  });

  it('renders a null missing-count as an em dash, never as zero', async () => {
    renderPage();
    await screen.findByText('Heat');
    // Scoped to the rows: the overview tiles legitimately show zeroes, and a
    // page-wide search for "0" would match those instead of the cell at issue.
    const movieRow = screen.getByText('Heat').closest('tr')!;
    const seriesRow = screen.getByText('Breaking Bad').closest('tr')!;
    expect(within(seriesRow).getByText('3')).toBeInTheDocument();
    // Not applicable is an em dash — rendering 0 would assert a fact we do not have.
    expect(within(movieRow).queryByText('0')).not.toBeInTheDocument();
    expect(within(movieRow).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('says plainly that it only observes', async () => {
    renderPage();
    expect(
      await screen.findByText(/never downloads, deletes, moves or repairs/i),
    ).toBeInTheDocument();
  });

  it('tells the operator when nothing has been analyzed yet', async () => {
    intelSpy.overview.mockResolvedValue({ ...overview, analyzed: 0, byFindingCode: [] });
    intelSpy.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
    renderPage();
    expect(await screen.findByText(/No titles have been analyzed yet/i)).toBeInTheDocument();
  });

  it('reports a skipped rebuild instead of claiming success', async () => {
    intelSpy.rebuild.mockResolvedValue({ skipped: true, movies: 0, series: 0, failed: 0 });
    renderPage();
    await screen.findByText('Breaking Bad');
    screen.getByRole('button', { name: /rebuild/i }).click();
    await waitFor(() => expect(toastSpy.info).toHaveBeenCalled());
    expect(toastSpy.success).not.toHaveBeenCalled();
  });
});
