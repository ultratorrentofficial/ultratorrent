import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Boxes, Download } from 'lucide-react';
import '@/i18n';
import type { NavGroup } from './navigation';

const groups: NavGroup[] = [
  {
    id: 'dashboard',
    title: 'Dashboard',
    icon: Boxes,
    items: [{ id: 'overview', to: '/dashboard', label: 'Dashboard', icon: Boxes }],
  },
  {
    id: 'media',
    title: 'Media',
    icon: Download,
    items: [{ id: 'media-items', to: '/media/items', label: 'Media Items', icon: Download }],
  },
];

vi.mock('./useVisibleNavGroups', () => ({ useVisibleNavGroups: () => groups }));

const { MobileDomainBar } = await import('./MobileDomainBar');

function renderAt(path: string, onOpenMenu = vi.fn()) {
  return {
    onOpenMenu,
    ...render(
      <MemoryRouter initialEntries={[path]}>
        <MobileDomainBar onOpenMenu={onOpenMenu} />
      </MemoryRouter>,
    ),
  };
}

describe('MobileDomainBar', () => {
  it('renders a tab per visible domain, each linking to its hub', () => {
    renderAt('/media/items');
    expect(screen.getByText('Media').closest('a')).toHaveAttribute('href', '/hub/media');
    expect(screen.getByText('Dashboard').closest('a')).toHaveAttribute('href', '/hub/dashboard');
  });

  it('marks the active domain with aria-current', () => {
    renderAt('/media/items');
    expect(screen.getByText('Media').closest('a')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Dashboard').closest('a')).not.toHaveAttribute('aria-current');
  });

  it('opens the full menu from the trailing button', () => {
    const { onOpenMenu } = renderAt('/media/items');
    fireEvent.click(screen.getByText('Menu'));
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
  });
});
