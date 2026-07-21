import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Boxes } from 'lucide-react';
import '@/i18n';
import { ModuleHub } from './ModuleHub';
import type { NavGroup } from './navigation';

const group: NavGroup = {
  id: 'media',
  title: 'Media',
  icon: Boxes,
  items: [
    { id: 'media-dashboard', to: '/media', label: 'Media Dashboard', icon: Boxes },
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
    // A pure action (no route) must not become a tile.
    { id: 'search', action: 'command', label: 'Search', icon: Boxes },
  ],
};

function renderHub() {
  return render(
    <MemoryRouter>
      <ModuleHub group={group} />
    </MemoryRouter>,
  );
}

describe('ModuleHub', () => {
  it('renders a tile per navigable page and links to its route', () => {
    renderHub();
    const dash = screen.getByText('Media Dashboard').closest('a')!;
    expect(dash).toHaveAttribute('href', '/media');
  });

  it('lists a page’s sub-pages as chips', () => {
    renderHub();
    const subtitles = screen.getByText('Subtitle Search').closest('a')!;
    expect(subtitles).toHaveAttribute('href', '/subtitles/search');
    expect(screen.getByText('Subtitle Sync')).toBeInTheDocument();
  });

  it('does not render a tile for a pure action launcher', () => {
    renderHub();
    // "Search" is an action (no route) — no tile.
    expect(screen.queryByText('Search')).not.toBeInTheDocument();
  });

  it('shows the domain title as a heading', () => {
    renderHub();
    expect(screen.getByRole('heading', { name: 'Media' })).toBeInTheDocument();
  });
});
