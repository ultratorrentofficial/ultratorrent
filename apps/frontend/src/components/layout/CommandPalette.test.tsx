import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Circle } from 'lucide-react';
import { CommandPalette } from './CommandPalette';
import type { NavSearchEntry } from './navigation';

const entries: NavSearchEntry[] = [
  { id: 'torrents', label: 'Torrents', descriptionKey: 'Torrents', icon: Circle, to: '/torrents', groupId: 'downloads', groupTitle: 'Downloads' },
  { id: 'users', label: 'Users', descriptionKey: 'Users', icon: Circle, to: '/users', groupId: 'administration', groupTitle: 'Administration' },
  // An action launcher — must never be offered as a navigation result.
  { id: 'search', label: 'Search', icon: Circle, action: 'command', groupId: 'overview', groupTitle: 'Overview' },
];

function setup() {
  const onNavigate = vi.fn();
  const onClose = vi.fn();
  render(<CommandPalette open entries={entries} onNavigate={onNavigate} onClose={onClose} />);
  return { onNavigate, onClose };
}

describe('CommandPalette', () => {
  it('lists navigable entries and excludes action launchers', () => {
    setup();
    expect(screen.getByText('Torrents')).toBeInTheDocument();
    expect(screen.getByText('Users')).toBeInTheDocument();
    // The Search action entry (no `to`) is not a navigable result.
    expect(screen.queryByText('Search')).not.toBeInTheDocument();
  });

  it('filters results by the query (label/group/description)', () => {
    setup();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'user' } });
    expect(screen.getByText('Users')).toBeInTheDocument();
    expect(screen.queryByText('Torrents')).not.toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', () => {
    setup();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'zzzzz' } });
    expect(screen.getByText('No matching pages.')).toBeInTheDocument();
  });

  it('navigates to the highlighted entry on Enter', () => {
    const { onNavigate, onClose } = setup();
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('/torrents');
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const { onClose } = setup();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows Pinned / Recent / Favorites quick-access sections when the query is empty', () => {
    render(
      <CommandPalette
        open
        entries={entries}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
        pinned={new Set(['torrents'])}
        recent={['users']}
        favorites={new Set()}
        onTogglePin={vi.fn()}
        onToggleFavorite={vi.fn()}
      />,
    );
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    expect(screen.getByText('Recent')).toBeInTheDocument();
    // Typing switches back to a flat filtered list (no section headers).
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'user' } });
    expect(screen.queryByText('Pinned')).not.toBeInTheDocument();
  });

  it('pins a row via its inline toggle without navigating', () => {
    const onTogglePin = vi.fn();
    const onNavigate = vi.fn();
    render(
      <CommandPalette
        open
        entries={entries}
        onNavigate={onNavigate}
        onClose={vi.fn()}
        pinned={new Set()}
        recent={[]}
        favorites={new Set()}
        onTogglePin={onTogglePin}
        onToggleFavorite={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: /pin to sidebar/i })[0]);
    expect(onTogglePin).toHaveBeenCalledWith('torrents');
    expect(onNavigate).not.toHaveBeenCalled(); // toggling never navigates
  });
});
