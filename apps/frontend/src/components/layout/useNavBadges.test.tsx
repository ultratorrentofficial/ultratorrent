import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PERMISSIONS } from '@ultratorrent/shared';
import { useNavBadges } from './useNavBadges';

const auth = vi.hoisted(() => ({ hasPermission: vi.fn() }));
const modules = vi.hoisted(() => ({ isEnabled: vi.fn() }));
const apiSpy = vi.hoisted(() => ({ duplicatesOverview: vi.fn() }));

vi.mock('@/auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/modules/ModuleContext', () => ({ useModules: () => modules }));
vi.mock('@/lib/api', () => ({ api: { media: apiSpy } }));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const overview = (needsReview: number) => ({
  groups: { total: 0, open: 0, ignored: 0, resolved: 0 },
  needsReview,
  byType: { file: 0, showFolder: 0 },
  byReason: {},
  potentialSavingsBytes: 0,
  lastDetectedAt: null,
  resolutions: {},
});

describe('useNavBadges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.hasPermission.mockReturnValue(true);
    modules.isEnabled.mockReturnValue(true);
  });

  it('surfaces a Duplicate Center badge when groups need review', async () => {
    apiSpy.duplicatesOverview.mockResolvedValue(overview(12));
    const { result } = renderHook(() => useNavBadges(), { wrapper });
    await waitFor(() => expect(result.current['media-duplicates']).toBeDefined());
    expect(result.current['media-duplicates']).toMatchObject({ count: 12, tone: 'warning' });
  });

  it('shows no badge when nothing needs review', async () => {
    apiSpy.duplicatesOverview.mockResolvedValue(overview(0));
    const { result } = renderHook(() => useNavBadges(), { wrapper });
    await waitFor(() => expect(apiSpy.duplicatesOverview).toHaveBeenCalled());
    expect(result.current['media-duplicates']).toBeUndefined();
  });

  it('does not query at all without the permission (lazy + gated)', async () => {
    auth.hasPermission.mockImplementation((p: string) => p !== PERMISSIONS.MEDIA_MANAGER_VIEW);
    const { result } = renderHook(() => useNavBadges(), { wrapper });
    // No permission → the query is disabled and no request fires.
    expect(apiSpy.duplicatesOverview).not.toHaveBeenCalled();
    expect(result.current['media-duplicates']).toBeUndefined();
  });

  it('does not query when the module is disabled', async () => {
    modules.isEnabled.mockReturnValue(false);
    renderHook(() => useNavBadges(), { wrapper });
    expect(apiSpy.duplicatesOverview).not.toHaveBeenCalled();
  });
});
