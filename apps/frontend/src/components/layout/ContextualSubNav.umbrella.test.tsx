import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Boxes } from 'lucide-react';
import '@/i18n';
import { resolveActiveContext, type NavGroup } from './navigation';

/**
 * A single-umbrella domain (one top-level item that only groups sub-sections,
 * like Media Server Analytics) with a THREE-level shape: umbrella → section →
 * page. Guards that Stream Control / Household render as sections UNDER the
 * umbrella, each expanding to its own pages. Labels are real nav.json keys so
 * they render to text.
 */
const groups: NavGroup[] = [
  {
    id: 'analytics',
    title: 'Analytics',
    icon: Boxes,
    items: [
      {
        id: 'msa',
        to: '/msa',
        label: 'Media Server Analytics',
        icon: Boxes,
        end: true,
        children: [
          { id: 'msa-live', to: '/msa/live', label: 'Live Activity', icon: Boxes },
          {
            id: 'msa-stream',
            to: '/msa/stream-limits',
            label: 'Stream Control',
            icon: Boxes,
            children: [
              { id: 'msa-limits', to: '/msa/stream-limits', label: 'Stream Limits', icon: Boxes },
              { id: 'msa-settings', to: '/msa/stream-control', label: 'Global Settings', icon: Boxes },
            ],
          },
        ],
      },
    ],
  },
];

vi.mock('./useVisibleNavGroups', () => ({ useVisibleNavGroups: () => groups }));
const { ContextualSubNav } = await import('./ContextualSubNav');

const renderAt = (path: string) =>
  render(<MemoryRouter initialEntries={[path]}><ContextualSubNav /></MemoryRouter>);

describe('umbrella-domain nav resolution', () => {
  it('resolves a third-level page to its domain, parent and grandparent', () => {
    const ctx = resolveActiveContext(groups, '/msa/stream-control');
    expect(ctx?.group.id).toBe('analytics');
    expect(ctx?.item.id).toBe('msa-settings');
    expect(ctx?.parent?.id).toBe('msa-stream');
    expect(ctx?.grandparent?.id).toBe('msa');
  });

  it('a facet route would NOT be lost (resolves inside the nav)', () => {
    // Global Settings' path is distinct from its group's landing; before the
    // three-level resolver this returned null and hid the whole sub-nav.
    expect(resolveActiveContext(groups, '/msa/stream-control')).not.toBeNull();
  });
});

describe('umbrella-domain ContextualSubNav', () => {
  it('promotes the umbrella children to primary tabs and expands the active section', () => {
    renderAt('/msa/stream-control');
    // Sections (umbrella children) are the primary tabs. "Stream Control" appears
    // both as its tab and as the active-section label above its pages.
    expect(screen.getByText('Live Activity')).toBeInTheDocument();
    expect(screen.getAllByText('Stream Control').length).toBeGreaterThanOrEqual(1);
    // The active section's pages appear as the child row.
    expect(screen.getByText('Stream Limits')).toBeInTheDocument();
    expect(screen.getByText('Global Settings')).toBeInTheDocument();
  });

  it('shows no child row on a plain leaf section', () => {
    renderAt('/msa/live');
    expect(screen.getByText('Live Activity')).toBeInTheDocument();
    expect(screen.getByText('Stream Control')).toBeInTheDocument();
    // Live Activity has no sub-pages, so a group's facets must not appear.
    expect(screen.queryByText('Global Settings')).toBeNull();
  });
});
