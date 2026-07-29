import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@/i18n';
import type { EntityRef } from '@ultratorrent/shared';

const groups = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('@/actions/useContextActions', () => ({
  useContextActions: () => ({ groups: groups.value, isLoading: false, isError: false }),
}));

import { ItemContextMenu } from './ItemContextMenu';

const verdict = (id: string, enabled = true, icon?: string) => ({
  action: { id, icon, group: 'metadata' }, enabled, reason: enabled ? undefined : 'permission',
});
const group = (...actions: unknown[]) => [{ group: 'metadata', actions }];
const selection: EntityRef[] = [{ type: 'media_item', id: 'i1' }];

const openMenu = (handlers: Record<string, ReturnType<typeof vi.fn>>, onClose = vi.fn()) =>
  render(
    <ItemContextMenu anchor={{ x: 10, y: 10 }} selection={selection} handlers={handlers as never} onClose={onClose} />,
  );

beforeEach(() => { groups.value = []; });

describe('ItemContextMenu', () => {
  it('renders the actions the resolver returned', () => {
    groups.value = group(verdict('media.metadata.refresh'), verdict('media.item.rename'));
    openMenu({ 'media.metadata.refresh': vi.fn(), 'media.item.rename': vi.fn() });
    expect(screen.getByRole('menuitem', { name: /Refresh metadata/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Rename/ })).toBeInTheDocument();
  });

  it('never renders an action with no handler', () => {
    /*
     * The load-bearing CAMA rule. The registry is platform-wide and resolves
     * actions this surface has not wired up; rendering one would be a menu item
     * that does nothing, which reads as broken rather than absent.
     */
    groups.value = group(verdict('media.metadata.refresh'), verdict('media.item.deleteFiles'));
    openMenu({ 'media.metadata.refresh': vi.fn() });
    expect(screen.getByRole('menuitem', { name: /Refresh metadata/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Delete files/ })).not.toBeInTheDocument();
  });

  it('renders nothing at all when nothing applies', () => {
    // An empty menu box is worse than no menu.
    groups.value = [];
    const { container } = openMenu({});
    expect(container).toBeEmptyDOMElement();
  });

  it('passes the selection to the handler, not the click target', () => {
    const refresh = vi.fn();
    groups.value = group(verdict('media.metadata.refresh'));
    openMenu({ 'media.metadata.refresh': refresh });
    fireEvent.click(screen.getByRole('menuitem', { name: /Refresh metadata/ }));
    expect(refresh).toHaveBeenCalledWith(selection);
  });

  it('closes before running the handler', () => {
    // Handlers open dialogs; a menu left on top of one is clickable.
    const order: string[] = [];
    const onClose = vi.fn(() => order.push('close'));
    groups.value = group(verdict('media.metadata.refresh'));
    openMenu({ 'media.metadata.refresh': vi.fn(() => order.push('run')) }, onClose);
    fireEvent.click(screen.getByRole('menuitem', { name: /Refresh metadata/ }));
    expect(order).toEqual(['close', 'run']);
  });

  it('disables an action the server marked unavailable', () => {
    groups.value = group(verdict('media.item.rename', false));
    const rename = vi.fn();
    openMenu({ 'media.item.rename': rename });
    const item = screen.getByRole('menuitem', { name: /Rename/ });
    expect(item).toBeDisabled();
    fireEvent.click(item);
    expect(rename).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    groups.value = group(verdict('media.metadata.refresh'));
    openMenu({ 'media.metadata.refresh': vi.fn() }, onClose);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on a mousedown outside itself', () => {
    const onClose = vi.fn();
    groups.value = group(verdict('media.metadata.refresh'));
    openMenu({ 'media.metadata.refresh': vi.fn() }, onClose);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it('suppresses the browser menu over itself', () => {
    groups.value = group(verdict('media.metadata.refresh'));
    openMenu({ 'media.metadata.refresh': vi.fn() });
    const menu = screen.getByRole('menu');
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(menu, e);
    expect(e.defaultPrevented).toBe(true);
  });
});
