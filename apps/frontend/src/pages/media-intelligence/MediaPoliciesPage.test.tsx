import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n';
import { MediaPoliciesPage } from './MediaPoliciesPage';

/**
 * Lifecycle policies.
 *
 * The claims worth pinning are the ones that keep the feature honest about
 * its own authority: that no control implies UltraTorrent will act on its
 * own, that a reader cannot reach the editor, and that a preview is labelled
 * a simulation and never silently presents a sample as a whole-library count.
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
  policies: vi.fn(),
  policy: vi.fn(),
  createPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  deletePolicy: vi.fn(),
  previewPolicy: vi.fn(),
}));
const mediaSpy = vi.hoisted(() => ({ libraries: vi.fn() }));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { mediaIntelligence: intelSpy, media: mediaSpy },
}));

const rows = () => within(screen.getByTestId('policy-rows'));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MediaPoliciesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const policy = (over: Record<string, unknown> = {}) => ({
  id: 'pol-1',
  name: 'TV Library Standard',
  description: null,
  enabled: true,
  scopeType: 'library',
  scopeId: 'lib-1',
  mode: 'recommend_only',
  quality: 'maintain_preferred',
  completeness: 'maintain_aired',
  subtitleLanguages: ['en', 'es'],
  acquisition: null,
  createdBy: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

const preview = (over: Record<string, unknown> = {}) => ({
  policyId: null,
  scopeType: 'global',
  scopeId: null,
  evaluated: 120,
  truncated: false,
  compliant: 100,
  drift: 15,
  unknown: 5,
  notApplicable: 0,
  byDimension: {},
  samples: [
    { entityType: 'series', entityId: 'show-1', title: 'Breaking Bad', dimensions: ['quality'] },
  ],
  ...over,
});

describe('MediaPoliciesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionSpy.allowed = true;
    intelSpy.policies.mockResolvedValue([policy()]);
    mediaSpy.libraries.mockResolvedValue([{ id: 'lib-1', name: 'TV Shows' }]);
  });

  it('lists what each policy maintains', async () => {
    renderPage();
    expect(await screen.findByText('TV Library Standard')).toBeInTheDocument();
    expect(rows().getByText(/Library/)).toBeInTheDocument();
  });

  it('never offers a mode that would act without approval', async () => {
    renderPage();
    await screen.findByText('TV Library Standard');
    screen.getByRole('button', { name: /Edit/i }).click();

    const modes = await screen.findByLabelText(/Mode/i);
    const values = within(modes).getAllByRole('option').map((o) => o.getAttribute('value'));
    // Phase 5 has no executor. An "automatic" option would promise one.
    expect(values).not.toContain('automatic');
    expect(values).toEqual(expect.arrayContaining(['recommend_only', 'approval_required']));
  });

  it('hides every authoring control from a reader', async () => {
    permissionSpy.allowed = false;
    renderPage();
    await screen.findByText('TV Library Standard');
    expect(screen.queryByRole('button', { name: /New policy|Create/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/i })).not.toBeInTheDocument();
  });

  it('lets a dimension say nothing, so it inherits rather than being pinned', async () => {
    intelSpy.createPolicy.mockResolvedValue({ ...policy(), reevaluationJobId: 'job-1' });
    renderPage();
    await screen.findByText('TV Library Standard');
    screen.getByRole('button', { name: /Create|New policy/i }).click();

    await screen.findByLabelText(/Name/i);
    screen.getByRole('button', { name: /^Save$/i }).click();

    await waitFor(() => expect(intelSpy.createPolicy).toHaveBeenCalled());
    const body = intelSpy.createPolicy.mock.calls[0][0];
    // '' in the UI must reach the API as null — the difference between
    // silence and an explicit decision is the whole inheritance contract.
    expect(body.quality).toBeNull();
    expect(body.completeness).toBeNull();
    expect(body.subtitleLanguages).toBeNull();
  });

  it('previews without saving anything', async () => {
    intelSpy.previewPolicy.mockResolvedValue(preview());
    renderPage();
    await screen.findByText('TV Library Standard');
    screen.getByRole('button', { name: /Edit/i }).click();

    (await screen.findByRole('button', { name: /Preview/i })).click();
    await waitFor(() => expect(intelSpy.previewPolicy).toHaveBeenCalled());

    expect(await screen.findByTestId('policy-preview')).toBeInTheDocument();
    // A simulation must never be mistaken for work already done.
    expect(intelSpy.updatePolicy).not.toHaveBeenCalled();
    expect(intelSpy.createPolicy).not.toHaveBeenCalled();
  });

  it('says a preview was a sample rather than presenting it as the whole library', async () => {
    intelSpy.previewPolicy.mockResolvedValue(preview({ truncated: true, evaluated: 500 }));
    renderPage();
    await screen.findByText('TV Library Standard');
    screen.getByRole('button', { name: /Edit/i }).click();
    (await screen.findByRole('button', { name: /Preview/i })).click();

    const panel = within(await screen.findByTestId('policy-preview'));
    expect(panel.getByText(/first 500|sample|more than/i)).toBeInTheDocument();
  });

  it('tells the operator the library is being re-evaluated after a change', async () => {
    intelSpy.deletePolicy.mockResolvedValue({ id: 'pol-1', reevaluationJobId: 'job-9' });
    renderPage();
    await screen.findByText('TV Library Standard');

    screen.getByRole('button', { name: /Delete/i }).click();
    await waitFor(() => expect(intelSpy.deletePolicy).toHaveBeenCalledWith('pol-1'));
    // Intent changed, so conclusions change; a silent list would look inert.
    expect(toastSpy.success).toHaveBeenCalled();
  });
});
