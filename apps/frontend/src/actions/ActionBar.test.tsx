import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ActionVerdict, EntityRef, ResolvedAction } from '@ultratorrent/shared';
import '@/i18n';
import { ActionBar } from './ActionBar';

/**
 * The toolbar shape, which had no test file until live testing found a hole in
 * it: a blocked action rendered disabled with a `title` nobody could see,
 * because `disabled:pointer-events-none` suppresses the hover that shows one.
 *
 * It also covers the collapsed-group path, which **no migrated surface reaches
 * today** — every one passes `primaryGroups` covering its groups, and none has
 * more than `INLINE_LIMIT` actions in a group. Untested *and* unreached is how
 * code rots, so it is exercised here even though production does not yet.
 */

function action(over: Partial<ResolvedAction> & Pick<ResolvedAction, 'id'>): ResolvedAction {
  return {
    group: 'metadata',
    entityTypes: ['media_item'],
    arity: 'any',
    operationsOnly: false,
    destructive: false,
    whenUnavailable: 'disable',
    async: true,
    order: 100,
    ...over,
  };
}

const ok = (a: ResolvedAction): ActionVerdict => ({ action: a, enabled: true });
const blocked = (a: ResolvedAction): ActionVerdict => ({
  action: a,
  enabled: false,
  reason: 'max_selection',
});

const selection: EntityRef[] = [{ type: 'media_item', id: 'i1' }];

describe('ActionBar — a blocked action explains itself', () => {
  it('puts the reason where it can actually be reached', () => {
    render(
      <ActionBar
        groups={[{ group: 'metadata', actions: [blocked(action({ id: 'media.metadata.refresh' }))] }]}
        selection={selection}
        handlers={{ 'media.metadata.refresh': vi.fn() }}
      />,
    );

    // The accessible name carries it, because a disabled control receives no
    // hover and its own `title` therefore never appears.
    const button = screen.getByRole('button', { name: /Refresh metadata .* selected/i });
    expect(button).toBeDisabled();
    expect(button.parentElement).toHaveAttribute('title', expect.stringMatching(/too many/i));
  });

  it('does not decorate an enabled action with a reason', () => {
    render(
      <ActionBar
        groups={[{ group: 'metadata', actions: [ok(action({ id: 'media.metadata.refresh' }))] }]}
        selection={selection}
        handlers={{ 'media.metadata.refresh': vi.fn() }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Refresh metadata' })).toBeEnabled();
  });
});

describe('ActionBar — group collapse', () => {
  const maintenance = [
    ok(action({ id: 'media.item.lock', group: 'maintenance', order: 1 })),
    ok(action({ id: 'media.item.unlock', group: 'maintenance', order: 2 })),
  ];

  it('renders a primary group inline', () => {
    render(
      <ActionBar
        groups={[{ group: 'maintenance', actions: maintenance }]}
        selection={selection}
        handlers={{ 'media.item.lock': vi.fn(), 'media.item.unlock': vi.fn() }}
        primaryGroups={['maintenance']}
      />,
    );
    // What the Library Browser actually shows: both buttons, no disclosure.
    expect(screen.getByRole('button', { name: 'Lock' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Maintenance/ })).not.toBeInTheDocument();
  });

  it('collapses a group that is not primary, and opens it on click', () => {
    render(
      <ActionBar
        groups={[{ group: 'maintenance', actions: maintenance }]}
        selection={selection}
        handlers={{ 'media.item.lock': vi.fn(), 'media.item.unlock': vi.fn() }}
        primaryGroups={['metadata']}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Lock' })).not.toBeInTheDocument();
    const disclosure = screen.getByRole('button', { name: /Maintenance/ });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitem', { name: /Lock/ })).toBeInTheDocument();
  });

  it('collapses a primary group once it grows past the inline limit', () => {
    // Five actions in one group is a toolbar nobody can scan, primary or not.
    const many = Array.from({ length: 5 }, (_, i) =>
      ok(action({ id: `media.thing.n${i}`, group: 'maintenance', order: i })),
    );
    render(
      <ActionBar
        groups={[{ group: 'maintenance', actions: many }]}
        selection={selection}
        handlers={Object.fromEntries(many.map((v) => [v.action.id, vi.fn()]))}
        primaryGroups={['maintenance']}
      />,
    );
    expect(screen.getByRole('button', { name: /Maintenance/ })).toBeInTheDocument();
  });

  it('runs the handler from inside a collapsed group and closes it', () => {
    const run = vi.fn();
    render(
      <ActionBar
        groups={[{ group: 'maintenance', actions: maintenance }]}
        selection={selection}
        handlers={{ 'media.item.lock': run, 'media.item.unlock': vi.fn() }}
        primaryGroups={['metadata']}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Maintenance/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Lock/ }));

    expect(run).toHaveBeenCalledWith(selection);
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });
});

describe('ActionBar — states', () => {
  it('says the catalogue is loading rather than rendering an empty bar', () => {
    render(<ActionBar groups={[]} selection={[]} handlers={{}} isLoading />);
    expect(screen.getByText(/Loading actions/i)).toBeInTheDocument();
  });

  it('says so when the catalogue could not be loaded', () => {
    render(<ActionBar groups={[]} selection={[]} handlers={{}} isError />);
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
  });

  it('reports a selection with nothing to offer', () => {
    render(<ActionBar groups={[]} selection={selection} handlers={{}} />);
    expect(screen.getByText(/No actions for this selection/i)).toBeInTheDocument();
  });
});
