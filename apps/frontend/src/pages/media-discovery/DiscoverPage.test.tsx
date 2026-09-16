import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { DiscoverPage } from './DiscoverPage';

/**
 * The inbox card.
 *
 * Each claim pinned here was a real defect found by checking an operator
 * report against live data: an ignored title could not be imported although
 * the API had always allowed it, and an ignore explained itself in a sentence
 * that named neither the template nor the categories the title carries.
 */

const toastSpy = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => toastSpy }));

const discoverySpy = vi.hoisted(() => ({
  providers: vi.fn(),
  inbox: vi.fn(),
  sync: vi.fn(),
  importItem: vi.fn(),
  declineItem: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { mediaDiscovery: discoverySpy },
}));

/*
 * The live shape of the commonest ignore: the provider reported no genres at
 * all, which is a different fix from "carries Sports and no template lists
 * it" — and the one-line reason cannot tell the two apart.
 */
const trace = [
  { step: 'release_window', status: 'pass', detail: 'Releases 2026-10-01 (series_premiere)' },
  { step: 'category_policy', status: 'info', detail: 'This title carries no categories, so none can qualify it' },
  { step: 'category_policy', status: 'fail', detail: 'No configured category matched' },
];

const item = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  mediaType: 'tv',
  title: 'Archive X',
  year: 2026,
  genres: [],
  overview: null,
  posterUrl: null,
  network: null,
  streamingService: null,
  popularity: null,
  rating: null,
  seriesStatus: null,
  premiereDate: null,
  externalIds: {},
  sourceProviders: ['tmdb'],
  confidence: 1,
  identityStatus: 'resolved',
  discoveryStatus: 'ignored',
  decision: 'ignore',
  decisionReason: 'No configured category matched this title',
  watchlistItemId: null,
  rssRuleId: null,
  lastSeenAt: '2026-09-16T00:00:00.000Z',
  releaseDates: [],
  evaluations: [
    {
      reason: 'No configured category matched this title',
      decision: 'ignore',
      createdAt: '2026-09-16T00:00:00.000Z',
      template: { name: 'Premium TV' },
      trace,
    },
  ],
  ...over,
});

const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 24 });

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DiscoverPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function withInbox(items: unknown[]) {
  vi.clearAllMocks();
  discoverySpy.providers.mockResolvedValue([{ id: 'tmdb', enabled: true }]);
  discoverySpy.inbox.mockResolvedValue(page(items));
}

describe('an ignored title can still be imported', () => {
  beforeEach(() => withInbox([item()]));

  /*
   * Ignoring is a TEMPLATE's judgement, not a person's, and the API never
   * checked status — `approve()` loads the row by id. Only the control was
   * missing.
   */
  it('offers Import', async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: 'Import' })).toBeInTheDocument();
  });

  it('does not offer Decline, which would be a no-op here', async () => {
    renderPage();
    await screen.findByText('Archive X');
    expect(screen.queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument();
  });

  it('imports through the API', async () => {
    discoverySpy.importItem.mockResolvedValue({ alreadyExisted: false });
    renderPage();

    (await screen.findByRole('button', { name: 'Import' })).click();
    await waitFor(() => expect(discoverySpy.importItem).toHaveBeenCalledWith('d1'));
  });
});

describe('a title held for review still offers both decisions', () => {
  beforeEach(() =>
    withInbox([item({ discoveryStatus: 'needs_review', decision: 'needs_review' })]),
  );

  it('offers Import and Decline', async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: 'Import' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
  });
});

describe('an ignore explains itself well enough to tune a template', () => {
  beforeEach(() => withInbox([item()]));

  /* The catalogue is scanned far more often than it is debugged. */
  it('keeps the trace collapsed until asked', async () => {
    renderPage();
    await screen.findByText('Archive X');
    expect(screen.queryByTestId('discovery-why')).not.toBeInTheDocument();
  });

  it('names the template and what each gate actually saw', async () => {
    renderPage();
    (await screen.findByRole('button', { name: 'Why?' })).click();

    const why = within(await screen.findByTestId('discovery-why'));
    // The template is the thing somebody has to open to fix this.
    expect(why.getByText(/Premium TV/)).toBeInTheDocument();
    // The distinction the one-line reason cannot make.
    expect(why.getByText(/carries no categories/)).toBeInTheDocument();
  });
});
