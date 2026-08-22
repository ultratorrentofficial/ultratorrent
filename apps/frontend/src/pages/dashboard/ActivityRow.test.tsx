import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@/i18n';
import { type ActivityItem } from '@/lib/api';
import { ActivityRow } from './ActivityRow';

const at = '2026-08-22T12:00:00.000Z';

function event(over: Partial<ActivityItem>): ActivityItem {
  return { id: 'e1', type: 'media.artwork.import', message: 'Imported artwork', at, ...over };
}

const SUMMARY: ActivityItem = event({
  id: 'group',
  message: 'Imported artwork: Beyond the Gates S02E122, Silo S02E01 +2 more',
  detail: '4 events',
  events: [
    event({ id: 'c1', message: 'Imported artwork: Beyond the Gates S02E122' }),
    event({ id: 'c2', message: 'Imported artwork: Silo S02E01' }),
    event({ id: 'c3', message: 'Imported artwork: Ted Lasso S03E12' }),
    event({ id: 'c4', message: 'Imported artwork: Carolina Caroline (2026)' }),
  ],
});

describe('ActivityRow', () => {
  it('renders a single event as plain text, with nothing to press', () => {
    render(<ActivityRow item={event({ message: 'Refreshed Plex' })} />);
    expect(screen.getByText('Refreshed Plex')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps a summary collapsed until it is asked to open', () => {
    render(<ActivityRow item={SUMMARY} onToggle={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    // The summary line names two of the four; the rest stay behind the toggle.
    expect(screen.queryByText('Imported artwork: Ted Lasso S03E12')).not.toBeInTheDocument();
  });

  it('lists every underlying event once expanded', () => {
    render(<ActivityRow item={SUMMARY} expanded onToggle={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    for (const name of ['Beyond the Gates S02E122', 'Silo S02E01', 'Ted Lasso S03E12', 'Carolina Caroline (2026)']) {
      expect(screen.getByText(`Imported artwork: ${name}`)).toBeInTheDocument();
    }
  });

  it('asks its parent to toggle rather than tracking the state itself', () => {
    // The feed opens one row at a time, which only works if the parent owns it.
    const onToggle = vi.fn();
    render(<ActivityRow item={SUMMARY} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('does not offer a toggle for a summary the parent cannot open', () => {
    render(<ActivityRow item={SUMMARY} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says how many events are behind the summary in the accessible name', () => {
    render(<ActivityRow item={SUMMARY} onToggle={vi.fn()} />);
    expect(screen.getByRole('button', { name: /4 events/ })).toBeInTheDocument();
  });
});
