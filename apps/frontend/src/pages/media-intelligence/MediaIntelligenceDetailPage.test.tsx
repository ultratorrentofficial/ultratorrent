import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

const intelSpy = vi.hoisted(() => ({ detail: vi.fn(), refresh: vi.fn(), drift: vi.fn() }));
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
  quality: {
    owned: {
      provenance: 'measured', resolutionClass: '1080p', resolutionOrdinal: 4,
      width: 1920, height: 1080, videoCodec: 'x265', videoBitDepth: 8,
      hdr: null, hdrFormat: null, audioCodec: 'e-ac-3', audioChannels: 6,
      bitrateKbps: 4200, frameRate: 23.976, durationSec: 2700, container: 'mkv',
      sizeBytes: 900_000_000,
    },
    ladder: {
      source: 'global_ladder',
      sourceLabel: 'Global Auto-Download Preferences',
      rungs: [
        { id: 'r0', name: '2160p HEVC', rung: 0, resolution: '2160p', codec: 'x265', source: null, quality: null, requiredTerms: [], excludedTerms: [], maxBytes: null, minBytes: null },
        { id: 'r1', name: '1080p x265', rung: 1, resolution: '1080p', codec: 'x265', source: null, quality: null, requiredTerms: [], excludedTerms: [], maxBytes: null, minBytes: null },
      ],
    },
    compliance: {
      status: 'acceptable', matchedRung: 1, matchedRungName: '1080p x265',
      preferredRung: 0, totalRungs: 2, upgradePotential: true,
      dimensions: [
        { dimension: 'resolution', result: 'pass', required: '1080p', actual: '1080p', reason: null },
        { dimension: 'source', result: 'not_evaluable', required: 'WEB-DL', actual: null, reason: 'release_name_only' },
      ],
      reasons: ['matched_fallback_rung'], unknownReason: null,
      preferenceSource: 'global_ladder', preferenceSourceLabel: 'Global Auto-Download Preferences',
    },
    aggregate: {
      evaluated: 62, preferred: 0, acceptable: 61, belowPreference: 1, unknown: 0,
      upgradePotential: 61, dominantResolution: '1080p', worstResolution: '720p', mixed: true,
    },
    measuredFileCount: 62, totalFileCount: 62,
  },
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

/** A lifecycle evaluation carrying only the drifts a case cares about. */
const evaluation = (drifts: Array<Record<string, unknown>>) => ({
  entityType: 'series',
  entityId: 'show-1',
  desiredState: {
    entityType: 'series',
    entityId: 'show-1',
    quality: { value: null, source: null, inherited: false, overridden: [] },
    completeness: { value: null, source: null, inherited: false, overridden: [] },
    subtitleLanguages: { value: null, source: null, inherited: false, overridden: [] },
    acquisition: { value: null, source: null, inherited: false, overridden: [] },
    mode: null,
    applicablePolicies: [],
    conflicts: [],
    evaluatedAt: '2026-09-15T00:00:00.000Z',
  },
  drifts,
  evaluatedAt: '2026-09-15T00:00:00.000Z',
});

const source = { policyId: 'pol-1', policyName: 'TV Library Standard', scopeType: 'library' };

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
    // Default: no policy covers this title. Most of this suite predates
    // Phase 5 and must keep asserting what it always did.
    intelSpy.drift.mockResolvedValue(evaluation([]));
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

  /**
   * Desired state versus actual.
   *
   * Phase 5 explains what should be maintained and stops there, so the claims
   * worth pinning are that an unknown never reads as a verdict, and that
   * nothing in this section offers to fix anything.
   */
  it('says no policy covers a title rather than implying it is correct', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Breaking Bad/ });
    const section = within(await screen.findByTestId('drift-section'));
    expect(section.getByText(/No lifecycle policy covers this title/i)).toBeInTheDocument();
    // The dangerous misreading: absence of a policy as a clean bill of health.
    expect(section.queryByText(/Matches/)).not.toBeInTheDocument();
  });

  it('cites the policy behind a verdict', async () => {
    intelSpy.drift.mockResolvedValue(
      evaluation([
        {
          dimension: 'quality',
          status: 'drift',
          desired: 'maintain_preferred',
          actual: 'below_preference',
          unknownReason: null,
          source,
          evidence: {},
        },
      ]),
    );
    renderPage();
    const section = within(await screen.findByTestId('drift-section'));
    expect(section.getByText('Differs')).toBeInTheDocument();
    // A verdict that cannot name its policy is unfalsifiable.
    expect(section.getByText(/TV Library Standard/)).toBeInTheDocument();
  });

  it('states why a dimension is unknown, and never calls it compliant or drift', async () => {
    intelSpy.drift.mockResolvedValue(
      evaluation([
        {
          dimension: 'subtitleLanguages',
          status: 'unknown',
          desired: ['en'],
          actual: null,
          unknownReason: 'subtitle_scan_state_unknown',
          source,
          evidence: {},
        },
      ]),
    );
    renderPage();
    const section = within(await screen.findByTestId('drift-section'));
    expect(section.getByText('Not known')).toBeInTheDocument();
    expect(section.getByText(/no subtitle scan has been recorded/i)).toBeInTheDocument();
    // An unprobed file is unmeasured, not wrong — and not fine either.
    expect(section.queryByText('Differs')).not.toBeInTheDocument();
    expect(section.queryByText('Matches')).not.toBeInTheDocument();
  });

  it('offers no remedy — this phase explains, it does not maintain', async () => {
    intelSpy.drift.mockResolvedValue(
      evaluation([
        {
          dimension: 'quality',
          status: 'drift',
          desired: 'maintain_preferred',
          actual: 'below_preference',
          unknownReason: null,
          source,
          evidence: {},
        },
      ]),
    );
    renderPage();
    const section = within(await screen.findByTestId('drift-section'));
    expect(
      section.queryByRole('button', { name: /fix|repair|upgrade|search|download|apply/i }),
    ).not.toBeInTheDocument();
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

describe('MediaIntelligenceDetailPage — quality compliance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    intelSpy.detail.mockResolvedValue(state);
    mediaSpy.showDetail.mockRejectedValue(new Error('no metadata'));
  });

  it('renders the compliance verdict and the rung it matched', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Breaking Bad/ });
    expect(screen.getByText('Acceptable')).toBeInTheDocument();
    expect(screen.getByText('1080p x265')).toBeInTheDocument();
    expect(screen.getByText(/rung 2 of 2/i)).toBeInTheDocument();
  });

  it('says POTENTIAL, never that an upgrade is available', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Breaking Bad/ });
    expect(screen.getAllByText(/Upgrade potential/i).length).toBeGreaterThan(0);
    // The distinction the whole feature rests on: nothing has been searched for.
    expect(screen.queryByText(/available/i)).not.toBeInTheDocument();
    expect(screen.getByText(/not that a better release has been found/i)).toBeInTheDocument();
  });

  it('names the preference source so the verdict is explainable', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Breaking Bad/ });
    expect(screen.getAllByText(/Global Auto-Download Preferences/).length).toBeGreaterThan(0);
  });

  it('shows a dimension it could not evaluate as such, not as a failure', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Breaking Bad/ });
    expect(screen.getByText(/Source: Cannot tell — describes a release name/i)).toBeInTheDocument();
  });

  it('keeps the single below-preference episode visible in the aggregate', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Breaking Bad/ });
    expect(screen.getByText(/Below preference: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Acceptable: 61/)).toBeInTheDocument();
    // The outlier must survive the summary.
    expect(screen.getByText(/Lowest: 720p/)).toBeInTheDocument();
  });

  it('renders unknown HDR as unknown rather than SDR or false', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Breaking Bad/ });
    expect(screen.queryByText('SDR')).not.toBeInTheDocument();
    expect(screen.queryByText('false')).not.toBeInTheDocument();
  });

  it('explains itself when no preferences apply', async () => {
    intelSpy.detail.mockResolvedValue({
      ...state,
      quality: {
        ...state.quality,
        compliance: {
          ...state.quality.compliance,
          status: 'unknown', matchedRung: null, upgradePotential: false,
          unknownReason: 'no_acquisition_preferences',
        },
      },
    });
    renderPage();
    await screen.findByRole('heading', { name: /Breaking Bad/ });
    expect(screen.getByText(/no Auto-Download preferences apply/i)).toBeInTheDocument();
  });
});
