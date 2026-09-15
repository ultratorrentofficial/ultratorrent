import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { MediaIntelligenceDetailPage } from './MediaIntelligenceDetailPage';

/**
 * The detail page exists to explain itself. These tests pin the two things
 * that make it explanatory rather than decorative: an unknown section says WHY
 * it is unknown, and a finding shows since when it has been true.
 */

const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), toast: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => toastSpy }));

vi.mock('@/components/media/MediaPoster', () => ({
  MediaPoster: ({ alt }: { alt: string }) => <img alt={alt} data-testid="poster" />,
}));

const intelSpy = vi.hoisted(() => ({ detail: vi.fn(), refresh: vi.fn() }));
const mediaSpy = vi.hoisted(() => ({ getItem: vi.fn(), showDetail: vi.fn() }));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status?: number;
  },
  api: { mediaIntelligence: intelSpy, media: mediaSpy },
}));

const known = (source: string) => ({ status: 'known' as const, source, observedAt: null });

const state = {
  entityType: 'series',
  entityId: 'show-1',
  identity: {
    ...known('media_manager'),
    title: 'Breaking Bad',
    year: 2008,
    matchStatus: 'matched',
    confidence: 1,
  },
  library: { ...known('media_manager'), present: true, libraryName: 'TV Shows', fileCount: 62 },
  completeness: { ...known('media_acquisition'), expected: 62, owned: 59, missing: 3 },
  technical: { ...known('media_manager'), measuredFileCount: 62 },
  metadata: { ...known('media_manager'), hasOverview: true },
  artwork: { ...known('media_manager'), posterPresent: true },
  subtitles: { ...known('media_manager'), itemsWithSubtitles: 62 },
  acquisition: { ...known('media_acquisition'), monitored: false },
  intake: { ...known('media_intake'), total: 62, failed: 0 },
  torrent: { ...known('torrents'), associatedCount: 57 },
  // The section under test: never measured, and it must say so.
  usage: {
    status: 'unknown' as const,
    source: 'media_server_analytics',
    observedAt: null,
    unknownReason: 'no_aggregate',
    playCount: null,
  },
  storage: { ...known('media_manager'), fileCount: 62 },
  health: {
    status: 'attention',
    score: 70,
    domains: [{ domain: 'completeness', status: 'known' }],
  },
  findings: [
    {
      code: 'EPISODES_MISSING',
      domain: 'completeness',
      severity: 'warning',
      entityType: 'series',
      entityId: 'show-1',
      evidence: { missing: 3 },
      source: 'media_acquisition',
      firstObservedAt: '2026-09-03T00:00:00.000Z',
      lastObservedAt: '2026-09-15T00:00:00.000Z',
      actionable: false,
    },
  ],
  freshness: { assembledAt: '2026-09-15T00:00:00.000Z', sections: [] },
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/media/intelligence/series/show-1']}>
        <Routes>
          <Route
            path="/media/intelligence/:entityType/:entityId"
            element={<MediaIntelligenceDetailPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MediaIntelligenceDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    intelSpy.detail.mockResolvedValue(state);
    mediaSpy.showDetail.mockResolvedValue({
      show: { id: 'show-1', title: 'Breaking Bad', year: 2008 },
      metadata: {
        title: 'Breaking Bad',
        overview: 'A chemistry teacher turns to manufacturing.',
        genres: ['Drama', 'Crime'],
        networks: ['AMC'],
        studios: [],
        status: 'ended',
        rating: 9.5,
        certification: 'TV-MA',
        providerName: 'tvdb',
      },
      seasons: [],
      artwork: [
        { id: 'a1', type: 'poster', selected: true, url: 'http://img/p.jpg', localPath: null, seasonNumber: null },
      ],
    });
    mediaSpy.getItem.mockResolvedValue({ title: 'Heat', metadata: null, artwork: [] });
  });

  it('shows the entity and its health verdict', async () => {
    renderPage();
    // By role: the title also appears as a fact inside the Identity card, and a
    // bare text query cannot tell the heading from the evidence.
    expect(await screen.findByRole('heading', { name: /Breaking Bad/ })).toBeInTheDocument();
    expect(screen.getByText(/Attention/i)).toBeInTheDocument();
  });

  it('explains WHY an unknown section is unknown instead of rendering a blank', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Breaking Bad/ });
    expect(screen.getByText(/no playback has been recorded/i)).toBeInTheDocument();
  });

  it('renders fact fields humanized, never as raw keys or raw booleans', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Breaking Bad/ });
    // The defect this guards: `Object.entries` printed "measuredFileCount" and
    // "true" straight to the operator.
    expect(screen.getByText('Measured file count')).toBeInTheDocument();
    expect(screen.queryByText('measuredFileCount')).not.toBeInTheDocument();
    expect(screen.getByText('Poster present')).toBeInTheDocument();
    expect(screen.queryByText('true')).not.toBeInTheDocument();
  });

  it('shows the artwork and metadata from the Media Manager', async () => {
    renderPage();
    expect(await screen.findByTestId('poster')).toBeInTheDocument();
    expect(screen.getByText(/A chemistry teacher turns to manufacturing/)).toBeInTheDocument();
    expect(screen.getByText('Drama')).toBeInTheDocument();
    expect(screen.getByText('AMC')).toBeInTheDocument();
    // A free-form status column, title-cased rather than shown raw.
    expect(screen.getByText('Ended')).toBeInTheDocument();
  });

  it('still renders the health verdict when no metadata exists', async () => {
    mediaSpy.showDetail.mockRejectedValue(new Error('nope'));
    renderPage();
    // The page's actual subject must survive a missing-artwork lookup.
    expect(await screen.findByRole('heading', { name: /Breaking Bad/ })).toBeInTheDocument();
    expect(screen.getByText(/Attention/i)).toBeInTheDocument();
    expect(screen.queryByTestId('poster')).not.toBeInTheDocument();
  });

  it('shows a finding with the date it was first observed', async () => {
    renderPage();
    expect(await screen.findByText(/Episodes missing/i)).toBeInTheDocument();
    expect(screen.getByText(/Since/i)).toBeInTheDocument();
  });
});
