import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Boxes } from 'lucide-react';
import '@/i18n';
import { resolveActiveContext, type NavGroup } from './navigation';

const groups: NavGroup[] = [
  {
    id: 'media',
    title: 'Media',
    icon: Boxes,
    items: [
      { id: 'media-dashboard', to: '/media', label: 'Media Dashboard', icon: Boxes, end: true },
      { id: 'media-items', to: '/media/items', label: 'Media Items', icon: Boxes },
      {
        id: 'subtitles',
        to: '/subtitles',
        label: 'Subtitles',
        icon: Boxes,
        children: [
          { id: 'subtitles-search', to: '/subtitles/search', label: 'Subtitle Search', icon: Boxes },
          { id: 'subtitles-sync', to: '/subtitles/sync', label: 'Subtitle Sync', icon: Boxes },
        ],
      },
    ],
  },
  {
    id: 'dashboard',
    title: 'Dashboard',
    icon: Boxes,
    items: [{ id: 'overview', to: '/dashboard', label: 'Dashboard', icon: Boxes }],
  },
];

// The component reads the RBAC-filtered nav through this hook; feed it fixtures.
vi.mock('./useVisibleNavGroups', () => ({ useVisibleNavGroups: () => groups }));

// Import AFTER the mock is registered.
const { ContextualSubNav } = await import('./ContextualSubNav');

describe('resolveActiveContext', () => {
  it('resolves a top-level page to its domain', () => {
    const ctx = resolveActiveContext(groups, '/media/items');
    expect(ctx?.group.id).toBe('media');
    expect(ctx?.item.id).toBe('media-items');
    expect(ctx?.parent).toBeUndefined();
  });

  it('resolves a sub-page to its parent (longest-prefix wins)', () => {
    const ctx = resolveActiveContext(groups, '/subtitles/search');
    expect(ctx?.item.id).toBe('subtitles-search');
    expect(ctx?.parent?.id).toBe('subtitles');
  });

  it('keeps a detail route within its branch', () => {
    const ctx = resolveActiveContext(groups, '/media/items/abc123');
    expect(ctx?.item.id).toBe('media-items');
  });

  it('returns null for a route outside the nav', () => {
    expect(resolveActiveContext(groups, '/account')).toBeNull();
  });
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ContextualSubNav />
    </MemoryRouter>,
  );
}

describe('ContextualSubNav', () => {
  it('renders the domain sibling tabs when inside a multi-item domain', () => {
    renderAt('/media/items');
    expect(screen.getByText('Media Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Media Items')).toBeInTheDocument();
    expect(screen.getByText('Subtitles')).toBeInTheDocument();
  });

  it('marks the active sibling tab with aria-current', () => {
    renderAt('/media/items');
    expect(screen.getByText('Media Items').closest('a')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Media Dashboard').closest('a')).not.toHaveAttribute('aria-current');
  });

  it('surfaces a branch’s children as a second row when inside it', () => {
    renderAt('/subtitles/sync');
    // sibling row still present…
    expect(screen.getByText('Media Items')).toBeInTheDocument();
    // …plus the Subtitles children.
    expect(screen.getByText('Subtitle Search')).toBeInTheDocument();
    const active = screen.getByText('Subtitle Sync').closest('a');
    expect(active).toHaveAttribute('aria-current', 'page');
  });

  it('renders nothing for a single-item domain', () => {
    const { container } = renderAt('/dashboard');
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a route outside the nav', () => {
    const { container } = renderAt('/account');
    expect(container).toBeEmptyDOMElement();
  });
});
