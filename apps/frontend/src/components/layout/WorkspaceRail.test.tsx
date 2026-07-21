import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Boxes, Clapperboard, Download } from 'lucide-react';
import '@/i18n';
import { workspaceLanding, type NavGroup } from './navigation';

// WorkspaceRail reads badges through this hook, which needs app context — stub it.
vi.mock('./useNavBadges', () => ({ useNavBadges: () => ({}) }));

const { WorkspaceRail } = await import('./WorkspaceRail');

const groups: NavGroup[] = [
  {
    id: 'dashboard',
    title: 'Dashboard',
    icon: Boxes,
    items: [{ id: 'dashboard', to: '/dashboard', label: 'Dashboard', icon: Boxes, end: true }],
  },
  {
    id: 'downloads',
    title: 'Downloads',
    icon: Download,
    items: [{ id: 'torrents', to: '/torrents', label: 'Torrents', icon: Download, end: true }],
  },
  {
    id: 'media',
    title: 'Media',
    icon: Clapperboard,
    items: [{ id: 'media-dashboard', to: '/media', label: 'Media Dashboard', icon: Clapperboard, end: true }],
  },
];

function renderRail(overrides: Partial<Parameters<typeof WorkspaceRail>[0]> = {}) {
  const onSelect = vi.fn();
  const onToggleSidebar = vi.fn();
  render(
    <MemoryRouter>
      <WorkspaceRail
        groups={groups}
        activeId="media"
        landingFor={workspaceLanding}
        onSelect={onSelect}
        sidebarHidden={false}
        onToggleSidebar={onToggleSidebar}
        {...overrides}
      />
    </MemoryRouter>,
  );
  return { onSelect, onToggleSidebar };
}

describe('WorkspaceRail', () => {
  it('renders one icon-link per workspace, each pointing at its landing', () => {
    renderRail();
    expect(screen.getByTitle(/^Media \(Ctrl\+3\)$/).closest('a')).toHaveAttribute('href', '/media');
    expect(screen.getByTitle(/^Downloads \(Ctrl\+2\)$/).closest('a')).toHaveAttribute('href', '/torrents');
  });

  it('marks the active workspace with aria-current', () => {
    renderRail();
    expect(screen.getByTitle(/^Media/).closest('a')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTitle(/^Downloads/).closest('a')).not.toHaveAttribute('aria-current');
  });

  it('exposes the Ctrl+N keyboard shortcut on each workspace', () => {
    renderRail();
    expect(screen.getByTitle(/^Dashboard/).closest('a')).toHaveAttribute('aria-keyshortcuts', 'Control+1');
  });

  it('calls onSelect when a workspace is clicked', () => {
    const { onSelect } = renderRail();
    fireEvent.click(screen.getByTitle(/^Downloads/));
    expect(onSelect).toHaveBeenCalledWith(groups[1]);
  });

  it('toggles the sidebar from the rail button', () => {
    const { onToggleSidebar } = renderRail();
    // The toggle button's label is the sidebar collapse/expand string.
    fireEvent.click(screen.getByRole('button'));
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });
});
