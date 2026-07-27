import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ResolvedAction } from '@ultratorrent/shared';
import '@/i18n';
import { ContextActionBar } from './ContextActionBar';

/**
 * The Library Browser bar, now driven by the CAMA catalogue.
 *
 * These tests changed shape with the migration, and deliberately so. The old
 * ones asserted that the component *hid a button when a permission was absent* —
 * that behaviour has moved to the server, where it is tested against the real
 * resolver. What is worth testing here is what remains local: that the bar
 * renders whatever the catalogue resolves, runs the right call, and refuses to
 * render an action it cannot actually perform.
 */

const toastSpy = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => toastSpy }));

const apiSpy = vi.hoisted(() => ({
  bulkItems: vi.fn(),
  scanLibrary: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  api: {
    media: { bulkItems: apiSpy.bulkItems, scanLibrary: apiSpy.scanLibrary },
    contextActions: { catalog: apiSpy.catalog },
  },
}));

function action(over: Partial<ResolvedAction> & Pick<ResolvedAction, 'id'>): ResolvedAction {
  return {
    group: 'metadata',
    entityTypes: ['media_item'],
    arity: 'any',
    operationsOnly: false,
    destructive: false,
    whenUnavailable: 'hide',
    async: true,
    order: 100,
    ...over,
  };
}

/** The Media Manager actions as the server actually resolves them. */
const CATALOG: ResolvedAction[] = [
  action({ id: 'media.library.scan', group: 'maintenance', entityTypes: [], arity: 'none', order: 10 }),
  action({ id: 'media.metadata.refresh', order: 10 }),
  action({ id: 'media.nfo.generate', order: 20 }),
  action({ id: 'media.item.lock', group: 'maintenance', order: 30 }),
  action({ id: 'media.item.unlock', group: 'maintenance', order: 40 }),
];

function catalogOf(actions: ResolvedAction[]) {
  return { actions, diagnostics: { total: actions.length, withheld: { permission: 0, module: 0, feature: 0, provider: 0 } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiSpy.catalog.mockResolvedValue(catalogOf(CATALOG));
  apiSpy.bulkItems.mockResolvedValue({ jobId: 'j1', accepted: 2, missing: [] });
  apiSpy.scanLibrary.mockResolvedValue({ jobId: 'scan-1' });
});

function renderBar(selectedIds: string[], opts: { onClear?: () => void; operationsMode?: boolean } = {}) {
  const onClear = opts.onClear ?? vi.fn();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <ContextActionBar
        libraryId="lib-1"
        selectedIds={selectedIds}
        onClear={onClear}
        operationsMode={opts.operationsMode}
      />
    </QueryClientProvider>,
  );
  return { onClear };
}

describe('ContextActionBar — selection drives the actions', () => {
  it('offers library work when nothing is selected', async () => {
    renderBar([]);
    expect(await screen.findByText('Scan library')).toBeInTheDocument();
    // Item operations are meaningless without items.
    expect(screen.queryByText('Refresh metadata')).not.toBeInTheDocument();
  });

  it('switches to item operations once something is selected', async () => {
    renderBar(['a', 'b']);
    expect(await screen.findByText('Refresh metadata')).toBeInTheDocument();
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    // A library-wide scan is not an operation on the two selected items.
    expect(screen.queryByText('Scan library')).not.toBeInTheDocument();
  });
});

describe('ContextActionBar — running an action', () => {
  it('sends the whole selection as ONE request, not one per item', async () => {
    renderBar(['a', 'b', 'c']);
    fireEvent.click(await screen.findByText('Refresh metadata'));
    await waitFor(() => expect(apiSpy.bulkItems).toHaveBeenCalledTimes(1));
    expect(apiSpy.bulkItems).toHaveBeenCalledWith('metadata', ['a', 'b', 'c']);
  });

  it('scans the library it was given', async () => {
    renderBar([]);
    fireEvent.click(await screen.findByText('Scan library'));
    await waitFor(() => expect(apiSpy.scanLibrary).toHaveBeenCalledWith('lib-1'));
  });

  it('reports queued rather than done when work runs as a job', async () => {
    renderBar(['a', 'b']);
    fireEvent.click(await screen.findByText('Generate NFO'));
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalled());
    expect(String(toastSpy.success.mock.calls[0][0])).toMatch(/Queued/i);
  });

  it('surfaces ids that resolved to nothing instead of swallowing them', async () => {
    // Acting on fewer items than were selected must not read as success.
    apiSpy.bulkItems.mockResolvedValue({ jobId: 'j1', accepted: 1, missing: ['b'] });
    renderBar(['a', 'b']);
    fireEvent.click(await screen.findByText('Refresh metadata'));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled());
  });
});

describe('ContextActionBar — what it refuses to render', () => {
  it('never renders an action it has no handler for', async () => {
    /*
     * The load-bearing safety rule. The registry is platform-wide and resolves
     * actions a surface may not have wired up — export and rename are declared
     * but unhandled here. A rendered button that does nothing reads as a broken
     * feature, which is worse than the action living somewhere else.
     */
    apiSpy.catalog.mockResolvedValue(
      catalogOf([
        ...CATALOG,
        action({ id: 'media.item.export', group: 'export', order: 10 }),
        action({ id: 'media.item.rename', group: 'maintenance', operationsOnly: true, order: 50 }),
      ]),
    );
    renderBar(['a'], { operationsMode: true });

    expect(await screen.findByText('Refresh metadata')).toBeInTheDocument();
    expect(screen.queryByText('Export CSV')).not.toBeInTheDocument();
    expect(screen.queryByText('Rename')).not.toBeInTheDocument();
  });

  it('renders nothing actionable when the catalogue is empty', async () => {
    // An empty catalogue is what a user with no media permissions receives.
    apiSpy.catalog.mockResolvedValue(catalogOf([]));
    renderBar(['a']);
    expect(await screen.findByText('No actions for this selection')).toBeInTheDocument();
    expect(screen.queryByText('Refresh metadata')).not.toBeInTheDocument();
  });

  it('says so when the catalogue cannot be loaded, rather than going blank', async () => {
    apiSpy.catalog.mockRejectedValue(new Error('offline'));
    renderBar(['a']);
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
  });
});

describe('ContextActionBar — Operations Mode', () => {
  it('withholds an operations-only action in Browse Mode', async () => {
    // `media.item.lock` is used as the probe: it is handled here, so its
    // absence is about the mode rather than about a missing handler.
    apiSpy.catalog.mockResolvedValue(
      catalogOf([action({ id: 'media.item.lock', group: 'maintenance', operationsOnly: true })]),
    );
    renderBar(['a'], { operationsMode: false });
    expect(await screen.findByText('No actions for this selection')).toBeInTheDocument();
  });

  it('reveals it in Operations Mode', async () => {
    apiSpy.catalog.mockResolvedValue(
      catalogOf([action({ id: 'media.item.lock', group: 'maintenance', operationsOnly: true })]),
    );
    renderBar(['a'], { operationsMode: true });
    expect(await screen.findByText('Lock')).toBeInTheDocument();
  });
});
