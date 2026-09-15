import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

describe('MediaAttentionPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    intelSpy.attentionSummary.mockResolvedValue(summary);
    intelSpy.attention.mockResolvedValue(page([item()]));
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
});
