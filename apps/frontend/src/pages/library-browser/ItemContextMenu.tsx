import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EntityRef } from '@ultratorrent/shared';
import { useContextActions } from '@/actions/useContextActions';
import type { ActionHandler } from '@/actions/ActionBar';
import { actionIcon } from '@/actions/action-icons';

/** Runtime-built keys; see the note on `DynamicT` in ActionBar. */
type DynamicT = (key: string, opts?: Record<string, unknown>) => string;

/** Where the menu was opened, in viewport coordinates. */
export interface ContextMenuAnchor {
  x: number;
  y: number;
}

/**
 * Right-click menu over a library item.
 *
 * A third CAMA shape beside the bar and the dropdown, and the same contract:
 * the server decides *what* is offered, `resolveActions` narrows it by the
 * selection, and an action with **no handler is never rendered** — a control
 * that does nothing reads as a broken feature rather than a missing one.
 *
 * What is different is the entry point. The bar requires a selection to exist
 * before it offers anything, so acting on one item meant ctrl-clicking to mark
 * it first. Right-click carries its own target: the caller passes the selection
 * this menu applies to, having already decided whether that is the clicked item
 * alone or the existing multi-selection it belongs to.
 */
export function ItemContextMenu({
  anchor,
  selection,
  handlers,
  onClose,
}: {
  anchor: ContextMenuAnchor;
  selection: EntityRef[];
  handlers: Record<string, ActionHandler>;
  onClose: () => void;
}) {
  const { t } = useTranslation('actions');
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(anchor);
  const { groups } = useContextActions({ selection });

  // Flattened in group order so the sequence matches the bar and the dropdown.
  const actions = useMemo(
    () => groups.flatMap((g) => g.actions).filter((v) => handlers[v.action.id]),
    [groups, handlers],
  );

  /*
   * Keep the menu on screen. Opened near the right or bottom edge — which is
   * most of a poster grid's last column — a menu pinned to the raw cursor
   * position would overflow and clip its own items.
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(anchor.x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(anchor.y, window.innerHeight - height - 8)),
    });
  }, [anchor.x, anchor.y, actions.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // `mousedown` rather than `click`: a click that lands outside should dismiss
    // before it activates whatever it hit.
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    // A scroll under an open menu leaves it pointing at a different tile.
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  // Nothing applicable is not an empty menu — it is no menu.
  if (!actions.length) return null;

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={(t as DynamicT)('contextMenu.label')}
      className="fixed z-50 min-w-52 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-lg"
      style={{ left: pos.x, top: pos.y }}
      // The browser menu would otherwise open on top of this one.
      onContextMenu={(e) => e.preventDefault()}
    >
      {actions.map(({ action, enabled }) => {
        const Glyph = actionIcon(action.icon);
        return (
        <button
          key={action.id}
          role="menuitem"
          type="button"
          disabled={!enabled}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => {
            // Close first: the handler may open a dialog, and a menu left
            // hanging over it is both ugly and clickable.
            onClose();
            handlers[action.id]?.(selection);
          }}
        >
          {Glyph && <Glyph className="h-4 w-4 shrink-0 opacity-70" />}
          <span className="truncate">{(t as DynamicT)(`action.${action.id}`)}</span>
        </button>
        );
      })}
    </div>
  );
}
