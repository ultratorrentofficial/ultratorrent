import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ActionVerdict, EntityRef, ResolvedAction } from '@ultratorrent/shared';
import '@/i18n';
import { ActionMenu } from './ActionMenu';

function action(over: Partial<ResolvedAction> & Pick<ResolvedAction, 'id'>): ResolvedAction {
  return {
    group: 'maintenance',
    entityTypes: ['job'],
    arity: 'any',
    operationsOnly: false,
    destructive: false,
    whenUnavailable: 'disable',
    async: true,
    order: 100,
    icon: 'Ban',
    ...over,
  };
}

const verdict = (a: ResolvedAction, enabled = true): ActionVerdict =>
  enabled ? { action: a, enabled } : { action: a, enabled, reason: 'entity_capability' };

const groups = (actions: ActionVerdict[]) => [{ group: 'maintenance' as const, actions }];
const selection: EntityRef[] = [{ type: 'job', id: 'j1', capabilities: ['cancel'] }];

describe('ActionMenu — icons variant', () => {
  it('labels an icon-only control so it is reachable without sight', () => {
    render(
      <ActionMenu
        groups={groups([verdict(action({ id: 'jobs.cancel' }))])}
        selection={selection}
        handlers={{ 'jobs.cancel': vi.fn() }}
      />,
    );
    // The button carries no text, so the accessible name is the only name.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('runs the handler with the selection', () => {
    const run = vi.fn();
    render(
      <ActionMenu
        groups={groups([verdict(action({ id: 'jobs.cancel' }))])}
        selection={selection}
        handlers={{ 'jobs.cancel': run }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(run).toHaveBeenCalledWith(selection);
  });

  it('does not let a row click through to whatever is behind it', () => {
    // Rows are usually clickable; acting must not also open the drawer.
    const rowClick = vi.fn();
    render(
      <div onClick={rowClick}>
        <ActionMenu
          groups={groups([verdict(action({ id: 'jobs.cancel' }))])}
          selection={selection}
          handlers={{ 'jobs.cancel': vi.fn() }}
        />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('disables a blocked action and says why', () => {
    render(
      <ActionMenu
        groups={groups([verdict(action({ id: 'jobs.cancel' }), false)])}
        selection={selection}
        handlers={{ 'jobs.cancel': vi.fn() }}
      />,
    );
    const button = screen.getByRole('button', { name: 'Cancel' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringMatching(/not available/i));
  });
});

describe('ActionMenu — what it refuses to render', () => {
  it('renders nothing at all when no action applies', () => {
    // Not an empty kebab: a menu button that opens onto nothing invites a click
    // and answers it with a blank panel.
    const { container } = render(
      <ActionMenu groups={[]} selection={selection} handlers={{ 'jobs.cancel': vi.fn() }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('never renders an action with no handler', () => {
    // The same rule the bar enforces: the registry is platform-wide and will
    // resolve actions a surface has not wired up.
    const { container } = render(
      <ActionMenu
        groups={groups([verdict(action({ id: 'jobs.rerun' }))])}
        selection={selection}
        handlers={{ 'jobs.cancel': vi.fn() }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ActionMenu — kebab variant', () => {
  it('hides actions until opened, then offers them', () => {
    render(
      <ActionMenu
        variant="kebab"
        groups={groups([verdict(action({ id: 'jobs.cancel' }))])}
        selection={selection}
        handlers={{ 'jobs.cancel': vi.fn() }}
      />,
    );
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: /Cancel/ })).toBeInTheDocument();
  });

  it('closes after running an action, so the menu does not linger over the row', () => {
    const run = vi.fn();
    render(
      <ActionMenu
        variant="kebab"
        groups={groups([verdict(action({ id: 'jobs.cancel' }))])}
        selection={selection}
        handlers={{ 'jobs.cancel': run }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Cancel/ }));
    expect(run).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('closes on Escape', () => {
    render(
      <ActionMenu
        variant="kebab"
        groups={groups([verdict(action({ id: 'jobs.cancel' }))])}
        selection={selection}
        handlers={{ 'jobs.cancel': vi.fn() }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });
});
