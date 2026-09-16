import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { MediaRemediationPage } from './MediaRemediationPage';

/**
 * The Remediation Center.
 *
 * The claims worth pinning are the ones that keep the surface honest about
 * its own authority: that a reader cannot approve, that the UI does not
 * re-derive safety the server already decided, that "we asked" is never
 * rendered as "it worked", and that stopping a plan does not promise to
 * undo what already ran.
 */

const toastSpy = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => toastSpy }));

const permissionSpy = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/auth/AuthContext', () => ({ usePermission: () => permissionSpy.allowed }));

const intelSpy = vi.hoisted(() => ({
  remediationPlans: vi.fn(),
  remediationSummary: vi.fn(),
  remediationPlan: vi.fn(),
  approveRemediationPlan: vi.fn(),
  cancelRemediationPlan: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { mediaIntelligence: intelSpy },
}));

const rows = () => within(screen.getByTestId('remediation-rows'));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MediaRemediationPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const step = (over: Record<string, unknown> = {}) => ({
  id: 'step-1',
  ordinal: 0,
  kind: 'refresh_metadata',
  ownerDomain: 'media_manager',
  capabilityId: 'media.metadata.refresh',
  requiredPermission: 'media_manager.edit_metadata',
  status: 'pending',
  inputSnapshot: { itemId: 'item-1' },
  expectedPostcondition: { metadataProviderPresent: true },
  attemptCount: 0,
  failureClass: null,
  failureMessage: null,
  skipReason: null,
  startedAt: null,
  completedAt: null,
  ...over,
});

const plan = (over: Record<string, unknown> = {}) => ({
  id: 'plan-1',
  entityType: 'movie',
  entityId: 'item-1',
  title: 'Heat',
  year: 1995,
  findingId: 'find-1',
  recommendationId: 'rec-1',
  policyId: null,
  policyName: null,
  findingCode: null,
  type: 'REFRESH_METADATA',
  status: 'proposed',
  riskClass: 'low',
  blockReason: null,
  blockSurvivesApproval: false,
  explanation: { intent: 'metadata_provider_present' },
  steps: [step()],
  approvedById: null,
  approvedByName: null,
  approvedAt: null,
  approvalInvalidated: false,
  expiresAt: '2099-01-01T00:00:00.000Z',
  startedAt: null,
  completedAt: null,
  supersededAt: null,
  supersededReason: null,
  failureClass: null,
  failureMessage: null,
  createdAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-16T00:00:00.000Z',
  ...over,
});

const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 25 });

const summary = {
  awaitingApproval: 2,
  approved: 0,
  executing: 1,
  waiting: 0,
  blocked: 3,
  failed: 1,
  recentlySucceeded: 7,
};

describe('MediaRemediationPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionSpy.allowed = true;
    intelSpy.remediationSummary.mockResolvedValue(summary);
    intelSpy.remediationPlans.mockResolvedValue(page([plan()]));
  });

  it('lists what is proposed, and what it intends to do', async () => {
    renderPage();
    expect(await screen.findByText('Heat')).toBeInTheDocument();
    expect(rows().getByText(/Fetch metadata from a provider/i)).toBeInTheDocument();
  });

  it('states plainly that nothing runs without approval', async () => {
    renderPage();
    // No automatic mode exists, so the page says so rather than leaving it
    // to be inferred from an absent toggle.
    expect(
      await screen.findByText(/Nothing here runs without your approval/i),
    ).toBeInTheDocument();
  });

  it('shows counts for the whole queue, not just this page', async () => {
    renderPage();
    const tiles = within(await screen.findByTestId('remediation-summary'));
    expect(tiles.getByText('3')).toBeInTheDocument();
    expect(tiles.getByText(/Blocked/i)).toBeInTheDocument();
  });
});

describe('approval is gated, and never re-derived in the browser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionSpy.allowed = true;
    intelSpy.remediationSummary.mockResolvedValue(summary);
  });

  it('hides every decision control from a reader', async () => {
    permissionSpy.allowed = false;
    intelSpy.remediationPlans.mockResolvedValue(page([plan()]));
    renderPage();

    await screen.findByText('Heat');
    expect(screen.queryByRole('button', { name: /Approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop/i })).not.toBeInTheDocument();
  });

  it('offers no Approve when the SERVER says the blocker survives approval', async () => {
    /*
     * The field is computed server-side precisely so the UI does not work it
     * out from `blockReason` and eventually disagree. An Approve button here
     * would promise something the API refuses with a 422.
     */
    intelSpy.remediationPlans.mockResolvedValue(
      page([plan({ blockReason: 'quality_not_measured', blockSurvivesApproval: true })]),
    );
    renderPage();

    await screen.findByText('Heat');
    expect(screen.queryByRole('button', { name: /Approve/i })).not.toBeInTheDocument();
    expect(rows().getByText(/never been measured/i)).toBeInTheDocument();
  });

  it('still offers Approve for a blocker that clears on its own', async () => {
    intelSpy.remediationPlans.mockResolvedValue(
      page([plan({ blockReason: 'budget_exhausted', blockSurvivesApproval: false })]),
    );
    renderPage();
    expect(await screen.findByRole('button', { name: /Approve/i })).toBeInTheDocument();
  });

  it('approves through the API after confirmation', async () => {
    intelSpy.remediationPlans.mockResolvedValue(page([plan()]));
    intelSpy.approveRemediationPlan.mockResolvedValue(plan({ status: 'approved' }));
    renderPage();

    (await screen.findByRole('button', { name: /Approve/i })).click();
    // Confirmed rather than fired on the first click: this authorises real work.
    const dialog = await screen.findByText(/Approve this plan\?/i);
    expect(dialog).toBeInTheDocument();

    screen.getAllByRole('button', { name: /^Approve$/i }).at(-1)!.click();
    await waitFor(() => expect(intelSpy.approveRemediationPlan).toHaveBeenCalledWith('plan-1'));
  });

  it('says a plan needs re-approval after its justification changed', async () => {
    intelSpy.remediationPlans.mockResolvedValue(page([plan({ approvalInvalidated: true })]));
    renderPage();
    expect(await screen.findByText(/changed after it was approved/i)).toBeInTheDocument();
  });
});

describe('"we asked" is never rendered as "it worked"', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionSpy.allowed = true;
    intelSpy.remediationSummary.mockResolvedValue(summary);
  });

  it('shows a verifying plan as checking the result, not as done', async () => {
    intelSpy.remediationPlans.mockResolvedValue(page([plan({ status: 'verifying' })]));
    renderPage();

    await screen.findByText('Heat');
    expect(rows().getByText(/Checking result/i)).toBeInTheDocument();
    expect(rows().queryByText(/^Done$/)).not.toBeInTheDocument();
  });

  it('explains what a verifying plan is waiting for, in the detail', async () => {
    intelSpy.remediationPlans.mockResolvedValue(page([plan({ status: 'verifying' })]));
    renderPage();

    (await screen.findByRole('button', { name: 'Heat' })).click();
    const detail = within(await screen.findByTestId('remediation-detail'));
    expect(detail.getByText(/checking whether it actually helped/i)).toBeInTheDocument();
  });
});

describe('the detail explains the plan rather than illustrating it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionSpy.allowed = true;
    intelSpy.remediationSummary.mockResolvedValue(summary);
    intelSpy.remediationPlans.mockResolvedValue(page([plan()]));
  });

  it('renders the real steps, naming the domain that owns the mutation', async () => {
    renderPage();
    (await screen.findByRole('button', { name: 'Heat' })).click();

    const steps = within(await screen.findByTestId('remediation-steps'));
    expect(steps.getByText(/Refresh metadata/i)).toBeInTheDocument();
    // The full phrase, not a bare `media_manager`: the permission string
    // below contains the domain as a prefix, so a substring matches twice.
    expect(steps.getByText(/Handled by media_manager/)).toBeInTheDocument();
  });

  it('shows the permission the owning domain still enforces', async () => {
    // Approving authorises the plan, not the mutation — visible, not implied.
    renderPage();
    (await screen.findByRole('button', { name: 'Heat' })).click();

    const steps = within(await screen.findByTestId('remediation-steps'));
    expect(steps.getByText(/media_manager\.edit_metadata/)).toBeInTheDocument();
  });
});

describe('stopping a plan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionSpy.allowed = true;
    intelSpy.remediationSummary.mockResolvedValue(summary);
    intelSpy.remediationPlans.mockResolvedValue(page([plan()]));
  });

  it('warns that completed work is not undone', async () => {
    renderPage();
    await screen.findByText('Heat');

    screen.getByRole('button', { name: /Stop/i }).click();
    expect(await screen.findByText(/already done is not undone/i)).toBeInTheDocument();
  });

  it('offers no Stop for a plan that already finished', async () => {
    intelSpy.remediationPlans.mockResolvedValue(page([plan({ status: 'succeeded' })]));
    renderPage();

    await screen.findByText('Heat');
    expect(screen.queryByRole('button', { name: /Stop/i })).not.toBeInTheDocument();
  });
});
