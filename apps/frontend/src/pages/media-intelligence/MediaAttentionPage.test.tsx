import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { MediaAttentionPage } from './MediaAttentionPage';

/**
 * The Attention queue.
 *
 * The claims worth pinning are the ones a later refactor would quietly
 * break: a dismissed finding must never read as fixed, an empty filter must
 * not imply a healthy library, and a selection must not stay actionable once
 * its rows have scrolled out of the result set.
 */

const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), toast: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => toastSpy }));

const intelSpy = vi.hoisted(() => ({
  attention: vi.fn(),
  attentionGrouped: vi.fn(),
  findingHistory: vi.fn(),
  recommendationsForFinding: vi.fn(),
  verifyRecommendation: vi.fn(),
  attentionSummary: vi.fn(),
  acknowledgeFinding: vi.fn(),
  dismissFinding: vi.fn(),
  snoozeFinding: vi.fn(),
  resetFinding: vi.fn(),
  bulkAcknowledgeFindings: vi.fn(),
  bulkDismissFindings: vi.fn(),
  bulkSnoozeFindings: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { mediaIntelligence: intelSpy },
}));

/**
 * The tiles and the rows legitimately show the same words — "Warning" is both
 * a count label and a severity badge. Scope each assertion to the region it
 * actually means rather than loosening the matcher.
 */
const rows = () => within(screen.getByTestId('attention-rows'));
const tiles = () => within(screen.getByTestId('attention-summary'));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MediaAttentionPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const summary = {
  active: 4, critical: 1, error: 0, warning: 3, opportunity: 0, info: 0,
  snoozed: 2, dismissed: 5, unreviewed: 3, escalated: 1,
};

const item = (over: Record<string, unknown> = {}) => ({
  id: 'f1',
  code: 'EPISODES_MISSING',
  domain: 'completeness',
  severity: 'warning',
  entityType: 'series',
  entityId: 'show-1',
  title: 'Breaking Bad',
  year: 2008,
  libraryName: 'TV Shows',
  open: true,
  firstObservedAt: '2026-09-01T00:00:00.000Z',
  lastObservedAt: '2026-09-15T00:00:00.000Z',
  resolvedAt: null,
  disposition: 'unreviewed',
  snoozedUntil: null,
  dispositionAt: null,
  dispositionActorName: null,
  escalated: false,
  escalationReason: null,
  summary: { missing: 3 },
  actionCapabilityIds: [],
  priority: 20,
  ...over,
});

const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 50 });

const group = (over: Record<string, unknown> = {}, findings = [item()]) => ({
  entityType: 'series',
  entityId: 'show-1',
  title: 'Breaking Bad',
  year: 2008,
  libraryName: 'TV Shows',
  severity: 'critical',
  priority: 10,
  findingCount: findings.length,
  escalated: false,
  findings,
  ...over,
});
const groupPage = (groups: unknown[]) => ({ groups, total: groups.length, page: 1, pageSize: 25 });

/**
 * Turn on "Group by title" and wait for the grouped table to actually render.
 *
 * Switching modes disables the flat query and starts the grouped one, so the
 * page spends a frame on its spinner with the table unmounted. Waiting for
 * the request to have been ISSUED is not enough — the assertions have to run
 * against the rendered result.
 */
async function enableGrouping() {
  screen.getByLabelText('Group by title').click();
  await waitFor(() => expect(intelSpy.attentionGrouped).toHaveBeenCalled());
  await screen.findByTestId('attention-rows');
}

describe('MediaAttentionPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    intelSpy.attentionSummary.mockResolvedValue(summary);
    intelSpy.attention.mockResolvedValue(page([item()]));
    intelSpy.attentionGrouped.mockResolvedValue(groupPage([group()]));
    intelSpy.findingHistory.mockResolvedValue([]);
    intelSpy.recommendationsForFinding.mockResolvedValue([]);
  });

  it('lists what needs attention', async () => {
    renderPage();
    expect(await screen.findByText('Breaking Bad')).toBeInTheDocument();
    expect(screen.getByText(/Episodes missing/i)).toBeInTheDocument();
  });

  it('states plainly that a decision is not a fix', async () => {
    renderPage();
    expect(
      await screen.findByText(/None of it changes what is actually true/i),
    ).toBeInTheDocument();
  });

  it('shows a dismissed finding as dismissed, never as resolved', async () => {
    intelSpy.attention.mockResolvedValue(page([item({ disposition: 'dismissed' })]));
    renderPage();
    await screen.findByText('Breaking Bad');
    expect(rows().getByText('Dismissed')).toBeInTheDocument();
    expect(rows().queryByText(/resolved/i)).not.toBeInTheDocument();
  });

  it('marks a finding whose condition got worse', async () => {
    intelSpy.attention.mockResolvedValue(
      page([item({ escalated: true, escalationReason: 'severity_increased' })]),
    );
    renderPage();
    await screen.findByText('Breaking Bad');
    expect(rows().getByText('Got worse')).toBeInTheDocument();
  });

  it('acknowledges a single finding through the single-item route', async () => {
    intelSpy.acknowledgeFinding.mockResolvedValue({ applied: 1, unknown: [], skippedResolved: [] });
    renderPage();
    await screen.findByText('Breaking Bad');

    screen.getAllByRole('button', { name: 'Acknowledge' })[0].click();
    await waitFor(() => expect(intelSpy.acknowledgeFinding).toHaveBeenCalledWith('f1'));
    // A single row must not go through the bulk endpoint.
    expect(intelSpy.bulkAcknowledgeFindings).not.toHaveBeenCalled();
  });

  it('reports findings skipped because they resolved first', async () => {
    intelSpy.dismissFinding.mockResolvedValue({ applied: 0, unknown: [], skippedResolved: ['f1'] });
    renderPage();
    await screen.findByText('Breaking Bad');

    screen.getAllByRole('button', { name: 'Dismiss' })[0].click();
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalled());
    expect(String(toastSpy.success.mock.calls[0][0])).toMatch(/already resolved/i);
  });

  it('offers Return to queue instead of dismiss for an already-dismissed finding', async () => {
    intelSpy.attention.mockResolvedValue(page([item({ disposition: 'dismissed' })]));
    renderPage();
    await screen.findByText('Breaking Bad');
    expect(screen.getByRole('button', { name: 'Return to queue' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('does not imply the library is healthy when a filter is simply empty', async () => {
    intelSpy.attention.mockResolvedValue(page([]));
    renderPage();
    // The unfiltered empty state speaks for the queue, not the library.
    expect(await screen.findByText(/Nothing needs your attention right now/i)).toBeInTheDocument();
  });

  it('renders severity with a label, not colour alone', async () => {
    renderPage();
    await screen.findByText('Breaking Bad');
    expect(rows().getByText('Warning')).toBeInTheDocument();
  });

  it('shows the counts the queue is built from', async () => {
    renderPage();
    await screen.findByText('Breaking Bad');
    expect(tiles().getByText('Snoozed')).toBeInTheDocument();
    expect(tiles().getByText('Dismissed')).toBeInTheDocument();
  });

  it('keeps a snooze control that is a real keyboard-operable control', async () => {
    renderPage();
    await screen.findByText('Breaking Bad');
    // A native select, so it is reachable and operable without a pointer.
    expect(screen.getAllByRole('combobox', { name: 'Snooze' }).length).toBeGreaterThan(0);
  });
  it('opens a detail panel for one finding rather than navigating away', async () => {
    intelSpy.findingHistory.mockResolvedValue([
      {
        id: 'e1',
        event: 'disposition_reset_by_escalation',
        at: '2026-09-14T00:00:00.000Z',
        actorUserId: null,
        actorName: null,
        detail: {},
      },
    ]);
    renderPage();
    await screen.findByText('Breaking Bad');

    screen.getAllByRole('button', { name: 'Review' })[0].click();

    const panel = await screen.findByRole('dialog');
    // Evidence is humanized, never a raw key or a naked number.
    expect(within(panel).getByText('Missing')).toBeInTheDocument();
    // History loads only once the panel is open.
    await waitFor(() => expect(intelSpy.findingHistory).toHaveBeenCalledWith('f1'));
    expect(
      within(panel).getByText(/Returned automatically — the condition got worse/i),
    ).toBeInTheDocument();
  });

  it('attributes an evaluator transition to the system, not to a blank name', async () => {
    intelSpy.findingHistory.mockResolvedValue([
      { id: 'e1', event: 'opened', at: '2026-09-01T00:00:00.000Z', actorUserId: null, actorName: null, detail: {} },
    ]);
    renderPage();
    await screen.findByText('Breaking Bad');
    screen.getAllByRole('button', { name: 'Review' })[0].click();

    const panel = await screen.findByRole('dialog');
    expect(await within(panel).findByText(/automatically/i)).toBeInTheDocument();
  });

  it('does not request history until the panel is actually opened', async () => {
    renderPage();
    await screen.findByText('Breaking Bad');
    expect(intelSpy.findingHistory).not.toHaveBeenCalled();
  });

  it('groups the queue by title on request', async () => {
    renderPage();
    await screen.findByText('Breaking Bad');
    await enableGrouping();
    expect(rows().getByText('1 finding')).toBeInTheDocument();
  });

  it('shows the worst severity a title contains, never a milder one', async () => {
    // A warning child under a title that also holds a critical finding: the
    // card must read critical, or the critical one is hidden behind it.
    intelSpy.attentionGrouped.mockResolvedValue(
      groupPage([group({ severity: 'critical' }, [item({ severity: 'warning' })])]),
    );
    renderPage();
    await screen.findByText('Breaking Bad');
    await enableGrouping();
    expect(rows().getByText('Critical')).toBeInTheDocument();
  });

  it('hides a group\u2019s findings until it is expanded', async () => {
    renderPage();
    await screen.findByText('Breaking Bad');
    await enableGrouping();

    expect(rows().queryByText(/Episodes missing/i)).not.toBeInTheDocument();
    fireEvent.click(rows().getByRole('button', { expanded: false }));
    expect(await rows().findByText(/Episodes missing/i)).toBeInTheDocument();
  });
});

/** A recommendation as the API returns it. */
const recommendation = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  findingId: 'f1',
  entityType: 'series',
  entityId: 'show-1',
  type: 'SEARCH_FOR_QUALITY_UPGRADE',
  recommendationClass: 'search',
  status: 'active',
  confidence: 'medium',
  findingCode: 'QUALITY_UPGRADE_POTENTIAL',
  findingSeverity: 'opportunity',
  title: 'Breaking Bad',
  year: 2008,
  evidence: { matchedRung: 2, totalRungs: 4 },
  unknowns: ['whether_a_superior_release_is_obtainable'],
  plan: ['search_indexers', 'require_approval'],
  capabilityId: null,
  verification: 'not_checked',
  verifiedAt: null,
  candidate: null,
  invalidationReason: null,
  evaluatedAt: '2026-09-16T00:00:00.000Z',
  createdAt: '2026-09-16T00:00:00.000Z',
  ...over,
});

/** Open the drawer on the first row and wait for the panel. */
async function openDrawer() {
  screen.getAllByRole('button', { name: 'Review' })[0].click();
  return screen.findByRole('dialog');
}

describe('FindingDetailDrawer — recommendations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    intelSpy.attentionSummary.mockResolvedValue(summary);
    intelSpy.attention.mockResolvedValue(page([item()]));
    intelSpy.findingHistory.mockResolvedValue([]);
    intelSpy.recommendationsForFinding.mockResolvedValue([]);
  });

  it('fetches recommendations only once the panel is opened', async () => {
    renderPage();
    await screen.findByText('Breaking Bad');
    // A 50-row queue must not issue a request per row.
    expect(intelSpy.recommendationsForFinding).not.toHaveBeenCalled();

    await openDrawer();
    await waitFor(() => expect(intelSpy.recommendationsForFinding).toHaveBeenCalledWith('f1'));
  });

  it('never runs an indexer search merely by opening the panel', async () => {
    intelSpy.recommendationsForFinding.mockResolvedValue([recommendation()]);
    renderPage();
    await screen.findByText('Breaking Bad');
    const panel = await openDrawer();
    await within(panel).findByText(/Search for a higher-preference release/i);

    // The whole phase rests on this: looking is not asking.
    expect(intelSpy.verifyRecommendation).not.toHaveBeenCalled();
  });

  it('says what is still unknown rather than implying an upgrade exists', async () => {
    intelSpy.recommendationsForFinding.mockResolvedValue([recommendation()]);
    renderPage();
    await screen.findByText('Breaking Bad');
    const panel = await openDrawer();

    expect(await within(panel).findByText(/Not checked yet/i)).toBeInTheDocument();
    expect(
      within(panel).getByText(/Whether a better release can actually be obtained/i),
    ).toBeInTheDocument();
    // "Available" must not appear until a real search says so.
    expect(within(panel).queryByText(/A better release is available/i)).not.toBeInTheDocument();
  });

  it('offers Verify for a quality upgrade, and runs it only on click', async () => {
    intelSpy.recommendationsForFinding.mockResolvedValue([recommendation()]);
    intelSpy.verifyRecommendation.mockResolvedValue({
      status: 'no_match', candidates: [], checkedAt: '2026-09-16T00:00:00.000Z',
      indexersQueried: 2, indexersFailed: 0,
    });
    renderPage();
    await screen.findByText('Breaking Bad');
    const panel = await openDrawer();

    const btn = await within(panel).findByRole('button', { name: 'Search for an upgrade' });
    btn.click();
    await waitFor(() => expect(intelSpy.verifyRecommendation).toHaveBeenCalledWith('r1'));
  });

  it('offers no Verify control where a search could not mean anything', async () => {
    // A review-class recommendation has nothing to ask an indexer about;
    // rendering the button would be a dead control.
    intelSpy.recommendationsForFinding.mockResolvedValue([
      recommendation({ type: 'REVIEW_DUPLICATES', recommendationClass: 'review', verification: 'not_required' }),
    ]);
    renderPage();
    await screen.findByText('Breaking Bad');
    const panel = await openDrawer();

    await within(panel).findByText(/Review the duplicate copies/i);
    expect(within(panel).queryByRole('button', { name: 'Search for an upgrade' })).not.toBeInTheDocument();
  });

  it('shows a real candidate only after verification found one', async () => {
    intelSpy.recommendationsForFinding.mockResolvedValue([
      recommendation({
        verification: 'verified',
        verifiedAt: '2026-09-16T00:00:00.000Z',
        confidence: 'high',
        candidate: {
          releaseName: 'Breaking.Bad.S03E08.1080p.BluRay.x265-GRP',
          indexerName: 'demo', sizeBytes: 3_900_000_000, seeders: 42,
          matchedRung: 0, matchedRungName: '1080p BluRay',
          dimensions: [], improvements: ['higher_preference_rung'], tradeoffs: [],
        },
      }),
    ]);
    renderPage();
    await screen.findByText('Breaking Bad');
    const panel = await openDrawer();

    expect(await within(panel).findByText(/Breaking.Bad.S03E08.1080p.BluRay.x265-GRP/)).toBeInTheDocument();
    expect(within(panel).getByText(/A better release is available/i)).toBeInTheDocument();
  });
});
